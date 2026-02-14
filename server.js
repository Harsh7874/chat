import express from "express";
import http from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import Redis from "ioredis";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();
// ====== CONFIG ======
const MONGO_URL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017/fastchat";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const PORT = process.env.PORT || 5000;
// ====== APP SETUP ======
const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ====== DB ======
await mongoose.connect(MONGO_URL);
console.log("Connected to MongoDB");
// Message Schema
const MessageSchema = new mongoose.Schema({
  conversationId: { type: String, index: true },
  from: String,
  to: String,
  text: String,
  status: { type: String, enum: ["sent", "delivered", "read"], default: "sent" },
  createdAt: { type: Date, default: Date.now }
});
// Compound index for fast pagination
MessageSchema.index({ conversationId: 1, _id: -1 });
const Message = mongoose.model("Message", MessageSchema);
// ====== REDIS CLIENTS ======
const redisPub = new Redis(REDIS_URL);    // publish
const redisSub = new Redis(REDIS_URL);    // subscribe only
console.log("Connected to Redis");
// ====== ONLINE USERS MAP ======
const onlineUsers = new Map(); // memberstackId -> socketId
app.get("/chats/:userId", async (req, res) => {
  const { userId } = req.params;
  const chats = await Message.aggregate([
    {
      $match: {
        $or: [{ from: userId }, { to: userId }]
      }
    },
    {
      $project: {
        otherUser: {
          $cond: [
            { $eq: ["$from", userId] },
            "$to",
            "$from"
          ]
        },
        createdAt: 1
      }
    },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$otherUser",
        lastMessageAt: { $first: "$createdAt" }
      }
    },
    { $sort: { lastMessageAt: -1 } }
  ]);
  res.json(chats.map(c => ({ userId: c._id })));
});
app.delete("/chats", async (req, res) => {
  const { user1, user2 } = req.query;
  if (!user1 || !user2) {
    return res.status(400).json({ error: "user1 and user2 required" });
  }
  await Message.deleteMany({
    $or: [
      { from: user1, to: user2 },
      { from: user2, to: user1 }
    ]
  });
  res.json({ success: true });
});
app.delete("/chats/all/:userId", async (req, res) => {
  const { userId } = req.params;
  await Message.deleteMany({
    $or: [{ from: userId }, { to: userId }]
  });
  res.json({ success: true });
});
// ====== SOCKET LOGIC ======
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  socket.on("register", (memberstackId) => {
    onlineUsers.set(memberstackId, socket.id);
    socket.memberstackId = memberstackId;
    console.log("Registered:", memberstackId);
  });
  socket.on("send_message", async (data) => {
    try {
      const { from, to, text, tempId } = data;
      const users = [from, to].sort(); // stable order
      const conversationId = `${users[0]}_${users[1]}`;
      const msg = {
        conversationId,
        from,
        to,
        text,
        status: "sent",
        createdAt: new Date()
      };
      const msgDoc = await Message.create(msg);
      const savedMsg = msgDoc.toObject();
      // Send back to sender with real ID
      socket.emit("message_sent", { tempId, savedMsg });
      // Publish for delivery
      await redisPub.publish("chat", JSON.stringify(savedMsg));
    } catch (err) {
      console.error("Send message error:", err);
    }
  });
  socket.on("delivered", async ({ messageId }) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg || msg.status !== "sent") return;
      msg.status = "delivered";
      await msg.save();
      const senderSocketId = onlineUsers.get(msg.from);
      if (senderSocketId) {
        io.to(senderSocketId).emit("status_update", { messageId: msg._id, status: "delivered" });
      }
    } catch (err) {
      console.error("Delivered error:", err);
    }
  });
  socket.on("mark_as_read", async ({ from, to }) => {
    try {
      // Find unread messages
      const unreadMsgs = await Message.find({ from, to, status: { $ne: "read" } }, { _id: 1 });
      if (unreadMsgs.length === 0) return;
      const ids = unreadMsgs.map(m => m._id);
      await Message.updateMany({ _id: { $in: ids } }, { status: "read" });
      const senderSocketId = onlineUsers.get(from);
      if (senderSocketId) {
        ids.forEach(id => {
          io.to(senderSocketId).emit("status_update", { messageId: id, status: "read" });
        });
      }
    } catch (err) {
      console.error("Mark as read error:", err);
    }
  });
  socket.on("disconnect", () => {
    if (socket.memberstackId) {
      onlineUsers.delete(socket.memberstackId);
    }
    console.log("Disconnected:", socket.id);
  });
});
// ====== REDIS SUBSCRIBER (REAL-TIME DELIVERY) ======
await redisSub.subscribe("chat");
redisSub.on("message", (channel, message) => {
  if (channel !== "chat") return;
  const msg = JSON.parse(message);
  const receiverSocketId = onlineUsers.get(msg.to);
  if (receiverSocketId) {
    io.to(receiverSocketId).emit("new_message", msg);
  }
});
// ====== BASIC ROUTE ======
app.get("/", (req, res) => {
  res.send("Fast Chat Server Running");
});
app.get("/messages", async (req, res) => {
  const { user1, user2, before, limit = 50 } = req.query;
  if (!user1 || !user2) {
    return res.status(400).json({ error: "user1 and user2 are required" });
  }
  const users = [user1, user2].sort();
  const conversationId = `${users[0]}_${users[1]}`;
  const query = { conversationId };
  // Cursor pagination: load messages older than this _id
  if (before) {
    query._id = { $lt: before };
  }  
  let messages = await Message.find(query)
    .sort({ _id: -1 })     // newest first (selects the correct batch)
    .limit(Number(limit));
  messages = messages.reverse(); // reverse to oldest-to-newest order in array
  res.json(messages);
});
// ====== START SERVER ======
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});