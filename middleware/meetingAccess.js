import jwt from "jsonwebtoken";
import Meeting from "../models/Meeting.js";

function getMeetingId(req) {
  return req.params.meetingId || req.body?.meetingId || req.query.meetingId;
}

async function verifyMeetingAccess(req, res, next, { allowDeactivated = false } = {}) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) {
    return res.status(401).json({ success: false, message: "Meeting access token required" });
  }

  let claims;
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ success: false, message: "Meeting access token is invalid or expired" });
  }

  const meetingId = getMeetingId(req);
  if (
    claims.purpose !== "meeting-access" ||
    !claims.meetingId ||
    claims.meetingId !== meetingId ||
    !["host", "participant", "guest"].includes(claims.role)
  ) {
    return res.status(403).json({ success: false, message: "Token is not authorized for this meeting" });
  }

  try {
    const meeting = await Meeting.findOne({ meetingId });
    if (
      !meeting ||
      ["ended", "inactive"].includes(meeting.status) ||
      (meeting.status === "deactivated" && !allowDeactivated)
    ) {
      return res.status(404).json({ success: false, message: "Meeting not found or unavailable" });
    }

    if (claims.role !== "guest") {
      const userId = claims.userId;
      const isHost = userId && meeting.hostId.equals(userId);
      const isParticipant =
        userId && meeting.participants.some((participantId) => participantId.equals(userId));
      const wasRemoved = meeting.removedUsers.some((removedId) => removedId.equals(userId));
      if (!userId || !isParticipant || wasRemoved || (claims.role === "host" && !isHost) || (claims.role === "participant" && isHost)) {
        return res.status(403).json({ success: false, message: "Meeting membership is no longer valid" });
      }
    } else if (
      !claims.guestId ||
      !claims.name ||
      meeting.removedGuests.includes(claims.guestId)
    ) {
      return res.status(403).json({ success: false, message: "Guest identity is invalid or has been removed" });
    }

    req.meeting = meeting;
    req.meetingAccess = claims;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireMeetingAccess(req, res, next) {
  return verifyMeetingAccess(req, res, next);
}

export function requireMeetingStatusAccess(req, res, next) {
  return verifyMeetingAccess(req, res, next, { allowDeactivated: true });
}
