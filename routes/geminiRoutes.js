import { Router } from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import { createLiveToken } from "../controllers/geminiController.js";

const router = Router();

router.post("/live-token", requireAuth, createLiveToken);

export default router;
