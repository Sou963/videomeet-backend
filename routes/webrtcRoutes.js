import { Router } from "express";
import { requireAuth } from "../middleware/authMiddleware.js";

const router = Router();
router.use(requireAuth);

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
router.get("/ice-servers", (req, res) => {
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

  if (
    process.env.TURN_URL &&
    process.env.TURN_USERNAME &&
    process.env.TURN_CREDENTIAL
  ) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME || "",
      credential: process.env.TURN_CREDENTIAL || "",
    });
  }

  res.json({ success: true, data: { iceServers } });
});

export default router;
