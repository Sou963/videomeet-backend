import crypto from "crypto";
export default function generateMeetingId(){ const chars=crypto.randomBytes(6).toString("hex"); return `${chars.slice(0,3)}-${chars.slice(3,6)}-${chars.slice(6,9)}`; }
