export function notFound(req,res){res.status(404).json({success:false,message:"Route not found"});}
export function errorHandler(err,req,res,next){console.error(err.message);res.status(err.status||500).json({success:false,message:err.message||"Server error"});}
