import { Router } from "express";
import bcrypt from "bcryptjs";
import Meeting from "../models/Meeting.js";
import generateMeetingId from "../utils/generateMeetingId.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { guestJoinRateLimit } from "../middleware/guestJoinRateLimit.js";
import {
  requireMeetingAccess,
  requireMeetingStatusAccess,
} from "../middleware/meetingAccess.js";
import { issueMeetingAccessToken } from "../utils/meetingAccessToken.js";

const router = Router();
const MAX_PARTICIPANTS = 4;
const MEETING_END_GRACE_MS = 5 * 60 * 1000;
const isJoinable = (meeting) => ["active", "scheduled"].includes(meeting.status);

// ── Public, non-sensitive meeting details for the pre-join screen ───
router.get("/:meetingId/info", async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ meetingId: req.params.meetingId })
      .select("meetingId title status passwordHash hostEndedAt deactivateAt deactivatedAt");
    if (!meeting) {
      return res.status(404).json({ success: false, message: "Meeting not found" });
    }
    return res.json({
      success: true,
      data: {
        meeting: {
          meetingId: meeting.meetingId,
          title: meeting.title,
          status: meeting.status,
          hasPassword: Boolean(meeting.passwordHash),
          hostEndedAt: meeting.hostEndedAt || null,
          deactivateAt: meeting.deactivateAt || null,
          deactivatedAt: meeting.deactivatedAt || null,
          serverNow: new Date().toISOString(),
        },
      },
    });
  } catch (error) {
    return next(error);
  }
});

// ── Issue a meeting-scoped guest credential ─────────────────────────
router.post("/:meetingId/guest-token", guestJoinRateLimit, async (req, res, next) => {
  try {
    const name =
      typeof req.body?.name === "string"
        ? req.body.name.replace(/[\u0000-\u001f\u007f]/g, "").trim()
        : "";
    if (name.length < 2 || name.length > 60) {
      return res.status(400).json({ success: false, message: "Display name must be 2 to 60 characters" });
    }

    const meeting = await Meeting.findOne({ meetingId: req.params.meetingId });
    if (!meeting || !isJoinable(meeting)) {
      return res.status(404).json({ success: false, message: "Meeting not found or unavailable" });
    }
    const password =
      typeof req.body?.password === "string" ? req.body.password.trim() : "";
    if (meeting.passwordHash && !(await bcrypt.compare(password, meeting.passwordHash))) {
      return res.status(403).json({ success: false, message: "Incorrect meeting password" });
    }
    const room = req.app.get("io").sockets.adapter.rooms.get(meeting.meetingId);
    if ((room?.size || 0) >= MAX_PARTICIPANTS) {
      return res.status(403).json({ success: false, message: `Meeting is full (max ${MAX_PARTICIPANTS} participants)` });
    }

    const access = issueMeetingAccessToken({
      meetingId: meeting.meetingId,
      role: "guest",
      name,
    });
    return res.json({
      success: true,
      data: { ...access, role: "guest", name, expiresIn: 7200 },
    });
  } catch (error) {
    return next(error);
  }
});

// ── Restore an already-authorized guest or participant session ──────
router.get("/:meetingId/session", requireMeetingAccess, (req, res) => {
  const { meeting, meetingAccess } = req;
  return res.json({
    success: true,
    data: {
      meeting: {
        meetingId: meeting.meetingId,
        title: meeting.title,
        status: meeting.status,
        hostEndedAt: meeting.hostEndedAt || null,
        deactivateAt: meeting.deactivateAt || null,
        deactivatedAt: meeting.deactivatedAt || null,
        serverNow: new Date().toISOString(),
      },
      identity: {
        name: meetingAccess.name,
        role: meetingAccess.role,
        userId: meetingAccess.userId || null,
      },
    },
  });
});

router.get("/:meetingId/status", requireMeetingStatusAccess, (req, res) => {
  const { meeting } = req;
  return res.json({
    success: true,
    data: {
      meetingId: meeting.meetingId,
      status: meeting.status,
      hostEndedAt: meeting.hostEndedAt || null,
      deactivateAt: meeting.deactivateAt || null,
      deactivatedAt: meeting.deactivatedAt || null,
      serverNow: new Date().toISOString(),
    },
  });
});

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

    return res.json({ success: true, data: { meeting: data } });
  } catch (error) {
    return next(error);
  }
});

// ── Issue a meeting-scoped credential for Socket.IO and meeting APIs ─
router.post("/:meetingId/access-token", async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ meetingId: req.params.meetingId });
    if (!meeting || !isJoinable(meeting)) {
      return res.status(404).json({ success: false, message: "Meeting not found or unavailable" });
    }
    if (!meeting.participants.some((id) => id.equals(req.user._id))) {
      return res.status(403).json({ success: false, message: "Join this meeting before requesting access" });
    }

    const role = meeting.hostId.equals(req.user._id) ? "host" : "participant";
    const access = issueMeetingAccessToken({
      meetingId: meeting.meetingId,
      role,
      userId: req.user._id,
      name: req.user.name,
    });
    return res.json({
      success: true,
      data: { ...access, role, name: req.user.name, expiresIn: 7200 },
    });
  } catch (error) {
    return next(error);
  }
});

// ── Activate/deactivate meeting (host only) ────────────────────────
router.patch("/:meetingId/status", async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Meeting status must be active or inactive",
      });
    }

    const meeting = await Meeting.findOne({ meetingId: req.params.meetingId });
    if (!meeting) {
      return res.status(404).json({ success: false, message: "Meeting not found" });
    }
    if (!meeting.hostId.equals(req.user._id)) {
      return res.status(403).json({ success: false, message: "Only the host can change this meeting's status" });
    }
    const updatedMeeting = await Meeting.findOneAndUpdate(
      {
        meetingId: req.params.meetingId,
        hostId: req.user._id,
        status: { $nin: ["ended", "ending", "deactivated"] },
      },
      { $set: { status } },
      { new: true }
    );
    if (!updatedMeeting) {
      return res.status(409).json({ success: false, message: "An ended meeting cannot be reactivated" });
    }
    return res.json({ success: true, data: { meeting: updatedMeeting } });
  } catch (error) {
    next(error);
  }
});

// ── Join meeting ────────────────────────────────────────────────────
router.post("/:meetingId/join", async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ meetingId: req.params.meetingId });

    if (!meeting || !isJoinable(meeting)) {
      return res.status(404).json({ success: false, message: "Meeting not found, inactive, or ended" });
    }

    const password = typeof req.body.password === "string" ? req.body.password.trim() : "";

    if (meeting.passwordHash && !(await bcrypt.compare(password, meeting.passwordHash))) {
      return res.status(403).json({ success: false, message: "Incorrect meeting password" });
    }
    if (meeting.removedUsers.some((id) => id.equals(req.user._id))) {
      return res.status(403).json({ success: false, message: "You were removed from this meeting" });
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
async function endMeeting(req, res, next) {
  try {
    let meeting = await Meeting.findOne({ meetingId: req.params.meetingId });
    if (!meeting) {
      return res.status(404).json({ success: false, message: "Meeting not found" });
    }
    if (!meeting.hostId.equals(req.user._id)) {
      return res.status(403).json({ success: false, message: "Only the host can end this meeting" });
    }

    if (meeting.status === "ending") {
      return res.json({
        success: true,
        data: {
          meetingId: meeting.meetingId,
          status: meeting.status,
          hostEndedAt: meeting.hostEndedAt,
          deactivateAt: meeting.deactivateAt,
          serverNow: new Date().toISOString(),
        },
      });
    }
    if (!["active", "scheduled", "inactive"].includes(meeting.status)) {
      return res.status(409).json({ success: false, message: "This meeting can no longer be ended" });
    }

    const hostEndedAt = new Date();
    meeting = await Meeting.findOneAndUpdate(
      {
        meetingId: req.params.meetingId,
        hostId: req.user._id,
        status: { $in: ["active", "scheduled", "inactive"] },
      },
      {
        $set: {
          status: "ending",
          hostEndedAt,
          deactivateAt: new Date(hostEndedAt.getTime() + MEETING_END_GRACE_MS),
        },
      },
      { new: true }
    );

    if (!meeting) {
      meeting = await Meeting.findOne({ meetingId: req.params.meetingId });
      if (meeting?.status === "ending" && meeting.hostId.equals(req.user._id)) {
        return res.json({
          success: true,
          data: {
            meetingId: meeting.meetingId,
            status: meeting.status,
            hostEndedAt: meeting.hostEndedAt,
            deactivateAt: meeting.deactivateAt,
            serverNow: new Date().toISOString(),
          },
        });
      }
      return res.status(409).json({ success: false, message: "Meeting status changed before it could be ended" });
    }

    const payload = {
      meetingId: meeting.meetingId,
      status: meeting.status,
      hostEndedAt: meeting.hostEndedAt.toISOString(),
      deactivateAt: meeting.deactivateAt.toISOString(),
      serverNow: new Date().toISOString(),
    };
    req.app.get("io").to(meeting.meetingId).emit("meeting-ending", payload);
    return res.json({ success: true, data: payload });
  } catch (error) {
    return next(error);
  }
}

router.post("/:meetingId/end", endMeeting);
router.delete("/:meetingId", endMeeting);

export default router;
