import { GoogleGenAI } from "@google/genai";
import Meeting from "../models/Meeting.js";

const MODEL = "gemini-3.5-live-translate-preview";
const TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const SESSION_START_WINDOW_MS = 60 * 1000;

export async function createLiveToken(req, res, next) {
  try {
    const meetingId = typeof req.body.meetingId === "string" ? req.body.meetingId.trim() : "";
    if (!meetingId) {
      return res.status(400).json({ success: false, message: "Meeting ID is required." });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({
        success: false,
        message: "Gemini translation is not configured on the server (GEMINI_API_KEY is missing).",
      });
    }

    const meeting = await Meeting.findOne({
      meetingId,
      status: { $ne: "ended" },
      participants: req.user._id,
    }).select("_id");

    if (!meeting) {
      return res.status(403).json({
        success: false,
        message: "Join this meeting before enabling translation.",
      });
    }

    const now = Date.now();
    const expiresAt = new Date(now + TOKEN_LIFETIME_MS).toISOString();
    const newSessionExpiresAt = new Date(now + SESSION_START_WINDOW_MS).toISOString();
    const client = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: { apiVersion: "v1beta" },
    });
    const token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime: expiresAt,
        newSessionExpireTime: newSessionExpiresAt,
        liveConnectConstraints: {
          model: MODEL,
          config: { responseModalities: ["AUDIO"] },
        },
        lockAdditionalFields: [],
      },
    });

    if (!token.name) {
      throw new Error("Gemini did not return an ephemeral token.");
    }

    return res.json({
      success: true,
      data: {
        token: token.name,
        expiresAt: token.expireTime || expiresAt,
        newSessionExpiresAt: token.newSessionExpireTime || newSessionExpiresAt,
      },
    });
  } catch (error) {
    return next(error);
  }
}
