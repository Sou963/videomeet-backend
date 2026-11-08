import mongoose from "mongoose";
const meetingSchema = new mongoose.Schema({ meetingId:{type:String,required:true,unique:true,index:true}, title:{type:String,required:true,trim:true,maxlength:120}, hostId:{type:mongoose.Schema.Types.ObjectId,ref:"User",required:true,index:true}, passwordHash:String, scheduledAt:Date, status:{type:String,enum:["scheduled","active","ended"],default:"active"}, participants:[{type:mongoose.Schema.Types.ObjectId,ref:"User"}] }, {timestamps:true});
export default mongoose.model("Meeting", meetingSchema);
