import Meeting from "../models/Meeting.js";

const DEACTIVATION_POLL_MS = 250;
const SOCKET_DISCONNECT_DELAY_MS = 250;

export function startMeetingDeactivationScheduler(io) {
  let running = false;

  async function deactivateExpiredMeetings() {
    if (running) return;
    running = true;

    try {
      const now = new Date();
      const expiredMeetings = await Meeting.find({
        status: "ending",
        deactivateAt: { $lte: now },
      }).select("meetingId");

      for (const { meetingId } of expiredMeetings) {
        const deactivatedAt = new Date();
        const meeting = await Meeting.findOneAndUpdate(
          {
            meetingId,
            status: "ending",
            deactivateAt: { $lte: deactivatedAt },
          },
          { $set: { status: "deactivated", deactivatedAt } },
          { new: true }
        ).select("meetingId deactivatedAt");

        if (!meeting) continue;

        io.to(meetingId).emit("meeting-deactivated", {
          meetingId,
          deactivatedAt: meeting.deactivatedAt.toISOString(),
          serverNow: new Date().toISOString(),
        });

        const sockets = io.sockets.adapter.rooms.get(meetingId);
        for (const socketId of sockets || []) {
          const socket = io.sockets.sockets.get(socketId);
          if (!socket) continue;
          const disconnectTimer = setTimeout(
            () => socket.disconnect(true),
            SOCKET_DISCONNECT_DELAY_MS
          );
          disconnectTimer.unref();
        }
      }
    } catch (error) {
      console.error("[Meeting] Deactivation sweep failed:", error);
    } finally {
      running = false;
    }
  }

  void deactivateExpiredMeetings();
  const timer = setInterval(deactivateExpiredMeetings, DEACTIVATION_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
