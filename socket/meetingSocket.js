import jwt from "jsonwebtoken";
import Meeting from "../models/Meeting.js";
import Message from "../models/Message.js";

const MAX_PARTICIPANTS = 4;
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
      });
    }
  }
  return members;
}

export function configureMeetingSocket(io) {
  // ── Authentication middleware ──────────────────────────────────────
  io.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers.cookie
          ?.match(/(?:^|; )token=([^;]+)/)?.[1];
      if (!token) return next(new Error("Authentication required"));
      const decoded = jwt.verify(
        decodeURIComponent(token),
        process.env.JWT_SECRET
      );
      socket.data.userId = decoded.userId;
      next();
    } catch {
      next(new Error("Invalid session"));
    }
  });

  io.on("connection", (socket) => {
    // ── Join room ────────────────────────────────────────────────────
    // Both "join-room" and "join-meeting" map to the same handler so
    // the MeetingRoom component and ChatPanel can share one socket.
    async function handleJoin({ meetingId, name } = {}) {
      const room = roomValue(meetingId);
      if (!room) return;

      // Already in this room? skip.
      if (socket.data.room === room) return;

      // Verify the meeting exists and is active
      const meeting = await Meeting.findOne({ meetingId: room }).catch(
        () => null
      );
      if (!meeting || meeting.status === "ended") {
        socket.emit("socket-error", { message: "Meeting not found or ended" });
        return;
      }

      // Enforce room capacity
      const existing = getRoomSockets(io, room);
      if (existing.size >= MAX_PARTICIPANTS) {
        socket.emit("socket-error", {
          message: `Meeting is full (max ${MAX_PARTICIPANTS} participants)`,
        });
        return;
      }

      socket.data.room = room;
      socket.data.name = getSafeName(name);
      socket.data.meetingId = room;
      socket.join(room);

      // Tell the new joiner who else is already in the room
      const members = buildMemberList(io, room, socket.id);
      socket.emit("room-members", members);

      // Tell everyone else that someone new joined
      const member = {
        peerId: socket.id,
        name: socket.data.name,
        userId: socket.data.userId,
      };
      socket.to(room).emit("peer-joined", member);
    }

    socket.on("join-room", handleJoin);
    socket.on("join-meeting", handleJoin);

    // ── Leave room ───────────────────────────────────────────────────
    socket.on("leave-meeting", ({ meetingId } = {}) => {
      const room = roomValue(meetingId);
      if (!room) return;
      socket.leave(room);
      socket.to(room).emit("peer-left", {
        peerId: socket.id,
        name: socket.data.name || "Participant",
      });
      socket.data.room = null;
      socket.data.meetingId = null;
    });

    // ── WebRTC signaling ─────────────────────────────────────────────
    // Only forward if both sender and target belong to the same room.
    socket.on("webrtc-signal", ({ meetingId, targetId, signal } = {}) => {
      const room = roomValue(meetingId);
      if (!room || !targetId || !signal) return;

      // Verify sender is in the room
      if (socket.data.room !== room) return;

      // Verify target is in the room
      const targetSocket = io.sockets.sockets.get(targetId);
      if (!targetSocket || targetSocket.data.room !== room) return;

      targetSocket.emit("webrtc-signal", {
        from: socket.id,
        signal,
        name: socket.data.name || "Participant",
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
    socket.on("chat-message", async ({ meetingId, message, name } = {}) => {
      const room = roomValue(meetingId);
      const text = typeof message === "string" ? message.trim() : "";
      if (!room || !text || text.length > 1500) return;

      // Verify membership
      if (socket.data.room !== room) return;

      try {
        const item = await Message.create({
          meetingId: room,
          userId: socket.data.userId,
          senderName: getSafeName(name),
          message: text,
        });
        io.to(room).emit("chat-message", item);
      } catch {
        socket.emit("socket-error", { message: "Message could not be saved" });
      }
    });

    // ── Raise hand ───────────────────────────────────────────────────
    socket.on("raise-hand", ({ meetingId, raised, name } = {}) => {
      const room = roomValue(meetingId);
      if (!room || socket.data.room !== room) return;
      io.to(room).emit("raise-hand", {
        peerId: socket.id,
        userId: socket.data.userId,
        raised: Boolean(raised),
        name: getSafeName(name),
      });
    });

    // ── Reactions ────────────────────────────────────────────────────
    socket.on("reaction", ({ meetingId, reaction, name } = {}) => {
      const room = roomValue(meetingId);
      if (!room || socket.data.room !== room) return;
      const allowed = ["👍", "❤️", "😂", "👏", "🎉", "🔥"];
      if (!allowed.includes(reaction)) return;
      io.to(room).emit("reaction", {
        peerId: socket.id,
        userId: socket.data.userId,
        reaction,
        name: getSafeName(name),
      });
    });

    // ── Host announcement ────────────────────────────────────────────
    socket.on("host-announcement", ({ meetingId, message } = {}) => {
      const room = roomValue(meetingId);
      const text = typeof message === "string" ? message.trim() : "";
      if (!room || !text || socket.data.room !== room) return;
      socket.to(room).emit("host-announcement", {
        message: text.slice(0, 500),
        name: socket.data.name,
      });
    });

    // ── Disconnect ───────────────────────────────────────────────────
    socket.on("disconnect", () => {
      const room = socket.data.room;
      if (room) {
        socket.to(room).emit("peer-left", {
          peerId: socket.id,
          name: socket.data.name || "Participant",
        });
      }
    });
  });
}
