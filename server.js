import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const environmentPath = path.join(serverDirectory, ".env");
dotenv.config({ path: environmentPath, quiet: true });

import http from "http";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { Server } from "socket.io";
import { connectDatabase } from "./db.js";
import authRoutes from "./routes/authRoutes.js";
import meetingRoutes from "./routes/meetingRoutes.js";
import messageRoutes from "./routes/messageRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import webrtcRoutes, { isTurnConfigured } from "./routes/webrtcRoutes.js";
import geminiRoutes from "./routes/geminiRoutes.js";
import { notFound, errorHandler } from "./middleware/errorMiddleware.js";
import { configureMeetingSocket } from "./socket/meetingSocket.js";

const app = express();
const server = http.createServer(app);
app.set("trust proxy", 1);
const allowedOrigins = [
  "https://videomeet-2-o-k5ui.onrender.com",
  "https://videomeet-2-o-jqxa.onrender.com",
  ...(process.env.CLIENT_URL || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
];
const corsOptions = { origin: allowedOrigins, credentials: true };
const io = new Server(server, {
  cors: corsOptions,
  pingTimeout: 60000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 120000,
  },
});

app.set("io", io);
app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.get("/api/health", (req, res) =>
  res.json({
    success: true,
    data: {
      status: "ok",
      webrtc: {
        turnConfigured: isTurnConfigured(),
      },
    },
  })
);
app.use("/api/auth", authRoutes);
app.use("/api/meetings", meetingRoutes);
app.use("/api/meetings", messageRoutes);
app.use("/api/users", userRoutes);
app.use("/api/webrtc", webrtcRoutes);
app.use("/api/gemini", geminiRoutes);
app.use(notFound);
app.use(errorHandler);
configureMeetingSocket(io);

console.info("Configuration loaded", { environmentPath });

connectDatabase()
  .then(() => server.listen(process.env.PORT || 5000, () => console.log(`API ready on ${process.env.PORT || 5000}`)))
  .catch((error) => {
    console.error("Database connection failed:", error.message);
    process.exit(1);
  });
