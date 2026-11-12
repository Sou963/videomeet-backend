import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";

export function issueMeetingAccessToken({ meetingId, role, userId, guestId, name }) {
  const identity = role === "guest" ? { guestId: guestId || randomUUID() } : { userId: String(userId) };
  const token = jwt.sign(
    { purpose: "meeting-access", meetingId, role, ...identity, name },
    process.env.JWT_SECRET,
    { expiresIn: "2h" }
  );
  return { token, ...identity };
}
