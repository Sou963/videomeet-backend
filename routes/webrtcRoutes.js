import { createHmac } from "node:crypto";
import { Router } from "express";
import { requireMeetingAccess } from "../middleware/meetingAccess.js";

const router = Router();
const TURN_CREDENTIAL_TTL_SECONDS = 60 * 60;

export function isTurnConfigured(environment = process.env) {
  const turnUrls = (environment.TURN_URL || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const hasCredentials =
    Boolean(environment.TURN_SHARED_SECRET) ||
    Boolean(environment.TURN_USERNAME && environment.TURN_CREDENTIAL);

  return (
    turnUrls.length > 0 &&
    turnUrls.every((url) => /^turns?:/i.test(url)) &&
    hasCredentials
  );
}

export function getIceServerConfiguration(environment = process.env) {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ];
  const turnUrls = (environment.TURN_URL || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const hasSharedSecret = Boolean(environment.TURN_SHARED_SECRET);
  const hasStaticCredentials = Boolean(
    environment.TURN_USERNAME && environment.TURN_CREDENTIAL
  );
  const turnConfigured = turnUrls.length > 0 && (hasSharedSecret || hasStaticCredentials);

  if (!turnConfigured) return { iceServers, turnConfigured: false };

  if (turnUrls.some((url) => !/^turns?:/i.test(url))) {
    throw new Error("TURN_URL entries must use the turn: or turns: scheme");
  }

  let username = environment.TURN_USERNAME;
  let credential = environment.TURN_CREDENTIAL;

  if (hasSharedSecret) {
    username = `${Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL_SECONDS}:${username || "videomeet"}`;
    credential = createHmac("sha1", environment.TURN_SHARED_SECRET)
      .update(username)
      .digest("base64");
  }

  iceServers.push({ urls: turnUrls, username, credential });
  return { iceServers, turnConfigured: true };
}

/**
 * GET /api/webrtc/ice-servers
 *
 * Returns the ICE server configuration the client needs
 * to create RTCPeerConnection instances.
 *
 * Always includes a public Google STUN server. Configure TURN_URL,
 * TURN_USERNAME, and TURN_CREDENTIAL for reliable connections across
 * restrictive NATs and firewalls.
 */
router.get("/ice-servers", requireMeetingAccess, (req, res) => {
  if (!["active", "scheduled"].includes(req.meeting.status)) {
    return res.status(409).json({
      success: false,
      message: "New WebRTC activities are unavailable after the host ends the meeting",
    });
  }
  const configuration = getIceServerConfiguration();
  res.json({ success: true, data: configuration });
});

export default router;
