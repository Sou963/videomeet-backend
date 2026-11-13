import mongoose from "mongoose";

const meetingSchema = new mongoose.Schema(
  {
    meetingId: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    hostId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    passwordHash: String,
    scheduledAt: Date,
    status: {
      type: String,
      enum: ["scheduled", "active", "inactive", "ended", "ending", "deactivated"],
      default: "active",
      index: true,
    },
    hostEndedAt: { type: Date, default: null },
    deactivateAt: { type: Date, default: null },
    deactivatedAt: { type: Date, default: null },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    removedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    removedGuests: [String],
  },
  { timestamps: true }
);

meetingSchema.index({ status: 1, deactivateAt: 1 });

export default mongoose.model("Meeting", meetingSchema);
