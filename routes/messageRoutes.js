import { Router } from "express";
import Message from "../models/Message.js";
import { requireMeetingAccess } from "../middleware/meetingAccess.js";

const router = Router();
router.use(requireMeetingAccess);

router.get("/:meetingId/messages", async (req, res, next) => {
  try {
    const messages = await Message.find({ meetingId: req.params.meetingId })
      .sort({ createdAt: 1 })
      .limit(200);
    return res.json({ success: true, data: { messages } });
  } catch (error) {
    return next(error);
  }
});

router.post("/:meetingId/messages", async (req, res, next) => {
  try {
    const text = typeof req.body.message === "string" ? req.body.message.trim() : "";
    if (!text || text.length > 1500) {
      return res.status(400).json({ success: false, message: "Message must be 1 to 1500 characters" });
    }
    const message = await Message.create({
      meetingId: req.params.meetingId,
      userId: req.meetingAccess.userId,
      guestId: req.meetingAccess.guestId,
      senderName: req.meetingAccess.name,
      message: text,
    });
    return res.status(201).json({ success: true, data: { message } });
  } catch (error) {
    return next(error);
  }
});

export default router;
