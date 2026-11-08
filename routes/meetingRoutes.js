import { Router } from "express";
import bcrypt from "bcryptjs";
import Meeting from "../models/Meeting.js";
import generateMeetingId from "../utils/generateMeetingId.js";
import { requireAuth } from "../middleware/authMiddleware.js";

const router = Router();
const MAX_PARTICIPANTS = 4;

router.use(requireAuth);

// ── Create meeting ──────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const { title, password, scheduledAt } = req.body;
    if (!title?.trim()) {
      return res.status(400).json({ success: false, message: "Meeting title is required" });
    }
    if (title.trim().length > 120) {
      return res.status(400).json({ success: false, message: "Meeting title is too long" });
    }

    let meetingId = generateMeetingId();
    while (await Meeting.exists({ meetingId })) {
      meetingId = generateMeetingId();
    }

    const meeting = await Meeting.create({
      meetingId,
      title: title.trim(),
      hostId: req.user._id,
      passwordHash: password?.trim() ? await bcrypt.hash(password.trim(), 12) : undefined,
      scheduledAt: scheduledAt || undefined,
      participants: [req.user._id],
    });

    res.status(201).json({ success: true, data: { meeting } });
  } catch (error) {
    next(error);
  }
});

// ── List meetings ───────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const meetings = await Meeting.find({
      $or: [{ hostId: req.user._id }, { participants: req.user._id }],
    })
      .populate("hostId", "name email")
      .sort({ createdAt: -1 });

    res.json({ success: true, data: { meetings } });
  } catch (error) {
    next(error);
  }
});

// ── Get meeting by ID ───────────────────────────────────────────────
router.get("/:meetingId", async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ meetingId: req.params.meetingId })
      .select("-passwordHash")
      .populate("hostId", "name email");

    if (!meeting) {
      return res.status(404).json({ success: false, message: "Meeting not found" });
    }

    const data = meeting.toObject();
    data.hasPassword = await Meeting.exists({
      meetingId: req.params.meetingId,
      passwordHash: { $exists: true, $ne: "" },
    });

    res.json({ success: true, data: { meeting: data } });
  } catch (error) {
    next(error);
  }
});

// ── Join meeting ────────────────────────────────────────────────────
router.post("/:meetingId/join", async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ meetingId: req.params.meetingId });

    if (!meeting || meeting.status === "ended") {
      return res.status(404).json({ success: false, message: "Meeting not found or ended" });
    }

    const password = typeof req.body.password === "string" ? req.body.password.trim() : "";

    if (meeting.passwordHash && !(await bcrypt.compare(password, meeting.passwordHash))) {
      return res.status(403).json({ success: false, message: "Incorrect meeting password" });
    }

    // Enforce participant capacity
    if (
      meeting.participants.length >= MAX_PARTICIPANTS &&
      !meeting.participants.some((id) => id.equals(req.user._id))
    ) {
      return res.status(403).json({
        success: false,
        message: `Meeting is full (max ${MAX_PARTICIPANTS} participants)`,
      });
    }

    if (!meeting.participants.some((id) => id.equals(req.user._id))) {
      meeting.participants.push(req.user._id);
      await meeting.save();
    }

    res.json({ success: true, data: { meeting } });
  } catch (error) {
    next(error);
  }
});

// ── End meeting (host only) ─────────────────────────────────────────
router.delete("/:meetingId", async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ meetingId: req.params.meetingId });
    if (!meeting) {
      return res.status(404).json({ success: false, message: "Meeting not found" });
    }
    if (!meeting.hostId.equals(req.user._id)) {
      return res.status(403).json({ success: false, message: "Only the host can end this meeting" });
    }

    meeting.status = "ended";
    meeting.endedAt = new Date();
    await meeting.save();

    req.app.get("io").to(meeting.meetingId).emit("meeting-ended");
    res.json({ success: true, data: {} });
  } catch (error) {
    next(error);
  }
});

export default router;
