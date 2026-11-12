import jwt from "jsonwebtoken";
import Meeting from "../models/Meeting.js";
import Message from "../models/Message.js";

const MAX_PARTICIPANTS = 4;
const DISCONNECT_GRACE_PERIOD = 30000;
const roomValue = (value) =>
  typeof value === "string" && value.length > 0 && value.length < 120
    ? value
    : null;
const getSafeName = (value) => String(value || "Participant").slice(0, 80);

/**
 * Returns a Set of socket IDs currently in a Socket.IO room.
 */
function getRoomSockets(io, room) {
  return io.sockets.adapter.rooms.get(room) ?? new Set();
}

/**
 * Build an array of { peerId, name, userId } for everyone in the room except `excludeId`.
 */
function buildMemberList(io, room, excludeId) {
  const sockets = getRoomSockets(io, room);
  const members = [];
  for (const sid of sockets) {
    if (sid === excludeId) continue;
    const s = io.sockets.sockets.get(sid);
    if (s) {
      members.push({
        peerId: sid,
        name: s.data.name || "Participant",
        userId: s.data.userId || null,
        role: s.data.role,
      });
    }
  }
  return members;
}

export function configureMeetingSocket(io) {
  const pendingDepartures = new Map();

  // ── Authentication middleware ──────────────────────────────────────
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.meetingToken;
      if (!token) return next(new Error("Authentication required"));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (
        decoded.purpose !== "meeting-access" ||
        !decoded.meetingId ||
        !["host", "participant", "guest"].includes(decoded.role) ||
        (decoded.role === "guest" ? !decoded.guestId : !decoded.userId)
      ) {
        return next(new Error("Invalid meeting access token"));
      }
      socket.data.meetingAccess = decoded;
      socket.data.userId = decoded.userId || null;
      socket.data.identityId = decoded.userId || decoded.guestId;
      socket.data.role = decoded.role;
      socket.data.name = getSafeName(decoded.name);
      next();
    } catch {
      next(new Error("Invalid or expired meeting access token"));
    }
  });

  io.on("connection", (socket) => {
    console.info("[Socket] Connected", { socketId: socket.id });
    const expiresIn = Math.max(
      0,
      (socket.data.meetingAccess.exp || 0) * 1000 - Date.now()
    );
    const accessExpiryTimer = setTimeout(() => socket.disconnect(true), expiresIn);
    accessExpiryTimer.unref();
    if (socket.recovered) {
      const pendingDeparture = pendingDepartures.get(socket.id);
      if (pendingDeparture) {
        clearTimeout(pendingDeparture);
        pendingDepartures.delete(socket.id);
      }
    }

    // ── Join room ────────────────────────────────────────────────────
    // Both "join-room" and "join-meeting" map to the same handler so
    // the MeetingRoom component and ChatPanel can share one socket.
    async function handleJoin({ meetingId } = {}) {
      const room = roomValue(meetingId);
      if (!room) return;
      if (socket.data.meetingAccess.meetingId !== room) {
        socket.emit("socket-error", {
          message: "Access token is not authorized for this meeting",
        });
        return;
      }

      // Verify the meeting exists and is active
      const meeting = await Meeting.findOne({ meetingId: room }).catch(
        () => null
      );
      if (!meeting || meeting.status === "ended" || meeting.status === "inactive") {
        socket.emit("socket-error", { message: "Meeting not found or unavailable" });
        return;
      }

      const access = socket.data.meetingAccess;
      if (
        access.role !== "guest" &&
        (!meeting.participants.some((id) => id.equals(access.userId)) ||
          meeting.removedUsers.some((id) => id.equals(access.userId)) ||
          (access.role === "host" && !meeting.hostId.equals(access.userId)) ||
          (access.role === "participant" && meeting.hostId.equals(access.userId)))
      ) {
        socket.emit("socket-error", {
          message: "Meeting membership is no longer valid",
        });
        return;
      }
      if (
        access.role === "guest" &&
        meeting.removedGuests.includes(access.guestId)
      ) {
        socket.emit("socket-error", { message: "You were removed from this meeting" });
        return;
      }

      if (socket.data.room === room) {
        socket.emit("room-members", buildMemberList(io, room, socket.id));
        return;
      }

      // Enforce room capacity
      const existing = getRoomSockets(io, room);
      const duplicate = [...existing].some((id) => {
        const member = io.sockets.sockets.get(id);
        return id !== socket.id && member?.data.identityId === socket.data.identityId;
      });
      if (duplicate) {
        socket.emit("socket-error", {
          message: "This identity is already connected to the meeting",
        });
        return;
      }
      if (existing.size >= MAX_PARTICIPANTS) {
        socket.emit("socket-error", {
          message: `Meeting is full (max ${MAX_PARTICIPANTS} participants)`,
        });
        return;
      }

      if (socket.data.room) {
        socket.leave(socket.data.room);
        socket.to(socket.data.room).emit("peer-left", {
          peerId: socket.id,
          name: socket.data.name || "Participant",
        });
      }

      socket.data.room = room;
      socket.data.meetingId = room;
      socket.join(room);
      console.info("[Socket] Joined meeting", {
        socketId: socket.id,
        meetingId: room,
        peerCount: existing.size + 1,
      });

      // Tell the new joiner who else is already in the room
      const members = buildMemberList(io, room, socket.id);
      socket.emit("room-members", members);

      // Tell everyone else that someone new joined
      const member = {
        peerId: socket.id,
        name: socket.data.name,
        userId: socket.data.userId,
        role: socket.data.role,
      };
      socket.to(room).emit("peer-joined", member);
    }

    socket.on("join-room", handleJoin);
    socket.on("join-meeting", handleJoin);

    // ── Leave room ───────────────────────────────────────────────────
    socket.on("leave-meeting", ({ meetingId } = {}) => {
      const room = roomValue(meetingId);
      if (!room) return;
      if (socket.data.room !== room) return;
      socket.leave(room);
      socket.to(room).emit("peer-left", {
        peerId: socket.id,
        name: socket.data.name || "Participant",
      });
      socket.data.room = null;
      socket.data.meetingId = null;
    });

    socket.on("remove-participant", async ({ meetingId, targetId } = {}) => {
      const room = roomValue(meetingId);
      const target = typeof targetId === "string" ? io.sockets.sockets.get(targetId) : null;
      if (
        !room ||
        socket.data.room !== room ||
        socket.data.role !== "host" ||
        !target ||
        target.id === socket.id ||
        target.data.room !== room ||
        target.data.role === "host"
      ) {
        return;
      }

      try {
        const meeting = await Meeting.findOne({ meetingId: room });
        if (!meeting || !meeting.hostId.equals(socket.data.userId)) {
          socket.emit("socket-error", { message: "Only the meeting host can remove participants" });
          return;
        }

        if (target.data.role === "guest") {
          if (!meeting.removedGuests.includes(target.data.meetingAccess.guestId)) {
            meeting.removedGuests.push(target.data.meetingAccess.guestId);
          }
        } else {
          const userId = target.data.userId;
          if (!meeting.removedUsers.some((id) => id.equals(userId))) {
            meeting.removedUsers.push(userId);
          }
          meeting.participants.pull(userId);
        }
        await meeting.save();

        target.emit("participant-removed", { meetingId: room });
        target.leave(room);
        target.data.room = null;
        target.data.meetingId = null;
        socket.to(room).emit("peer-left", {
          peerId: target.id,
          name: target.data.name || "Participant",
        });
      } catch (error) {
        console.error("[Socket] Failed to remove participant", error);
        socket.emit("socket-error", { message: "Participant could not be removed" });
      }
    });

    // ── WebRTC signaling ─────────────────────────────────────────────
    // Only forward if both sender and target belong to the same room.
    socket.on("webrtc-signal", ({ meetingId, targetId, signal } = {}) => {
      const room = roomValue(meetingId);
      if (
        !room ||
        !targetId ||
        targetId === socket.id ||
        !signal ||
        !["offer", "answer", "candidate", "ice-restart-request"].includes(signal.type)
      ) {
        return;
      }

      // Verify sender is in the room
      if (socket.data.room !== room) return;

      // Verify target is in the room
      const targetSocket = io.sockets.sockets.get(targetId);
      if (!targetSocket || targetSocket.data.room !== room) return;

      if (signal.type !== "candidate") {
        console.debug("[Socket] Forwarding WebRTC signal", {
          meetingId: room,
          from: socket.id,
          to: targetId,
          type: signal.type,
        });
      }
      targetSocket.emit("webrtc-signal", {
        from: socket.id,
        signal,
        name: socket.data.name || "Participant",
        role: socket.data.role,
      });
    });

    // ── Media status updates ─────────────────────────────────────────
    socket.on(
      "media-status",
      ({ meetingId, audio, video, screenSharing } = {}) => {
        const room = roomValue(meetingId);
        if (!room || socket.data.room !== room) return;
        socket.to(room).emit("media-status", {
          peerId: socket.id,
          audio: Boolean(audio),
          video: Boolean(video),
          screenSharing: Boolean(screenSharing),
        });
      }
    );

    // ── Chat ─────────────────────────────────────────────────────────
    socket.on("chat-message", async ({ meetingId, message } = {}) => {
      const room = roomValue(meetingId);
      const text = typeof message === "string" ? message.trim() : "";
      if (!room || !text || text.length > 1500) return;

      // Verify membership
      if (socket.data.room !== room) return;

      try {
        const item = await Message.create({
          meetingId: room,
          userId: socket.data.userId,
          guestId: socket.data.meetingAccess.guestId,
          senderName: socket.data.name,
          message: text,
        });
        io.to(room).emit("chat-message", item);
      } catch {
        socket.emit("socket-error", { message: "Message could not be saved" });
      }
    });

    // ── Raise hand ───────────────────────────────────────────────────
    socket.on("raise-hand", ({ meetingId, raised } = {}) => {
      const room = roomValue(meetingId);
      if (!room || socket.data.room !== room) return;
      io.to(room).emit("raise-hand", {
        peerId: socket.id,
        userId: socket.data.userId,
        raised: Boolean(raised),
        name: socket.data.name,
      });
    });

    // ── Reactions ────────────────────────────────────────────────────
    socket.on("reaction", ({ meetingId, reaction } = {}) => {
      const room = roomValue(meetingId);
      if (!room || socket.data.room !== room) return;
      const allowed = ["👍", "❤️", "😂", "👏", "🎉", "🔥"];
      if (!allowed.includes(reaction)) return;
      io.to(room).emit("reaction", {
        peerId: socket.id,
        userId: socket.data.userId,
        reaction,
        name: socket.data.name,
      });
    });

    // ── Host announcement ────────────────────────────────────────────
    socket.on("host-announcement", ({ meetingId, message } = {}) => {
      const room = roomValue(meetingId);
      const text = typeof message === "string" ? message.trim() : "";
      if (!room || !text || socket.data.room !== room || socket.data.role !== "host") return;
      socket.to(room).emit("host-announcement", {
        message: text.slice(0, 500),
        name: socket.data.name,
      });
    });

    // ── Disconnect ───────────────────────────────────────────────────
    socket.on("disconnect", () => {
      clearTimeout(accessExpiryTimer);
      const room = socket.data.room;
      console.info("[Socket] Disconnected", { socketId: socket.id, meetingId: room || null });
      if (room) {
        const timer = setTimeout(() => {
          pendingDepartures.delete(socket.id);
          io.to(room).except(socket.id).emit("peer-left", {
            peerId: socket.id,
            name: socket.data.name || "Participant",
          });
        }, DISCONNECT_GRACE_PERIOD);
        timer.unref();
        pendingDepartures.set(socket.id, timer);
      }
    });
  });
}
