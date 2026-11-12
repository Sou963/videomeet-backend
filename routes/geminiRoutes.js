import { Router } from "express";
import { requireMeetingAccess } from "../middleware/meetingAccess.js";
import { createLiveToken } from "../controllers/geminiController.js";

const router = Router();

router.post("/live-token", requireMeetingAccess, createLiveToken);

export default router;
