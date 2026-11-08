import mongoose from "mongoose";
const messageSchema = new mongoose.Schema({ meetingId:{type:String,required:true,index:true}, userId:{type:mongoose.Schema.Types.ObjectId,ref:"User",required:true}, senderName:{type:String,required:true}, message:{type:String,required:true,trim:true,maxlength:1500} }, {timestamps:true});
messageSchema.index({meetingId:1,createdAt:1});
export default mongoose.model("Message", messageSchema);
