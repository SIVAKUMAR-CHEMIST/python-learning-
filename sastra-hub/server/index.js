const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// ══════════════ IN-MEMORY STORE ══════════════
const rooms = {};        // roomId -> room object
const socketUser = {};   // socketId -> { email, roomId, userId }

// Auto-delete rooms older than 24 hours
setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach(roomId => {
    if (now - rooms[roomId].createdAt > 86400000) {
      io.to(roomId).emit('session-expired');
      delete rooms[roomId];
      console.log(`Room ${roomId} auto-deleted after 24h`);
    }
  });
}, 60000); // check every minute

// ══════════════ REST API ══════════════
// Get all rooms (without passwords)
app.get('/api/rooms', (req, res) => {
  const publicRooms = Object.values(rooms).map(r => ({
    id: r.id,
    name: r.name,
    subject: r.subject,
    hasPassword: !!r.password,
    memberCount: r.members.length,
    owner: r.owner,
    createdAt: r.createdAt
  }));
  res.json(publicRooms);
});

// Create room
app.post('/api/rooms', (req, res) => {
  const { name, subject, password, ownerEmail } = req.body;
  if (!name || !subject || !ownerEmail) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const roomId = uuidv4().slice(0, 8).toUpperCase();
  rooms[roomId] = {
    id: roomId,
    name,
    subject,
    password: password || null,
    owner: ownerEmail,
    members: [],
    messages: [],
    files: [],
    createdAt: Date.now()
  };
  res.json({ roomId });
});

// Verify room password
app.post('/api/rooms/:roomId/verify', (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!room.password) return res.json({ ok: true });
  if (room.password === req.body.password) return res.json({ ok: true });
  return res.status(401).json({ error: 'Wrong password' });
});

// Delete room (owner only)
app.delete('/api/rooms/:roomId', (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.owner !== req.body.email) return res.status(403).json({ error: 'Not owner' });
  io.to(req.params.roomId).emit('room-closed', { chatHistory: room.messages });
  delete rooms[req.params.roomId];
  res.json({ ok: true });
});

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// ══════════════ SOCKET.IO ══════════════
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // ── JOIN ROOM ──
  socket.on('join-room', ({ roomId, email }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('error', 'Room not found'); return; }

    const userId = socket.id;
    const initials = email.split('@')[0].slice(0, 2).toUpperCase();
    const colorIdx = Math.abs(email.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 0)) % 5;
    const colors = ['#3b82f6','#10b981','#f59e0b','#8b5cf6','#ef4444'];
    const user = { socketId: socket.id, email, initials, color: colors[colorIdx], userId };

    // Remove if already in room
    room.members = room.members.filter(m => m.email !== email);
    room.members.push(user);
    socketUser[socket.id] = { email, roomId, userId };

    socket.join(roomId);

    // Send room state to joining user
    socket.emit('room-joined', {
      room: {
        id: room.id,
        name: room.name,
        subject: room.subject,
        owner: room.owner,
        members: room.members,
        messages: room.messages,
        createdAt: room.createdAt
      },
      mySocketId: socket.id
    });

    // Notify others
    socket.to(roomId).emit('user-joined', { user });
    console.log(`${email} joined room ${roomId}`);
  });

  // ── CHAT MESSAGE ──
  socket.on('send-message', ({ roomId, text }) => {
    const info = socketUser[socket.id];
    if (!info || !rooms[roomId]) return;
    const room = rooms[roomId];
    const member = room.members.find(m => m.socketId === socket.id);
    if (!member) return;
    const msg = {
      id: uuidv4(),
      user: { email: member.email, initials: member.initials, color: member.color },
      text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    room.messages.push(msg);
    io.to(roomId).emit('new-message', msg);
  });

  // ── FILE SHARED (metadata only) ──
  socket.on('file-shared', ({ roomId, file }) => {
    const info = socketUser[socket.id];
    if (!info || !rooms[roomId]) return;
    rooms[roomId].files.push(file);
    socket.to(roomId).emit('file-added', file);
  });

  // ── WEBRTC SIGNALING ──
  socket.on('webrtc-offer', ({ targetSocketId, offer, fromSocketId }) => {
    io.to(targetSocketId).emit('webrtc-offer', { offer, fromSocketId });
  });

  socket.on('webrtc-answer', ({ targetSocketId, answer, fromSocketId }) => {
    io.to(targetSocketId).emit('webrtc-answer', { answer, fromSocketId });
  });

  socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate, fromSocketId }) => {
    io.to(targetSocketId).emit('webrtc-ice-candidate', { candidate, fromSocketId });
  });

  // ── MEDIA STATE (mic/cam toggle) ──
  socket.on('media-state', ({ roomId, micOn, camOn }) => {
    socket.to(roomId).emit('peer-media-state', {
      socketId: socket.id,
      micOn,
      camOn
    });
  });

  // ── KICK MEMBER (owner only) ──
  socket.on('kick-member', ({ roomId, targetEmail, ownerEmail }) => {
    const room = rooms[roomId];
    if (!room || room.owner !== ownerEmail) return;
    const target = room.members.find(m => m.email === targetEmail);
    if (target) {
      io.to(target.socketId).emit('kicked');
      room.members = room.members.filter(m => m.email !== targetEmail);
      io.to(roomId).emit('member-list-update', { members: room.members });
    }
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    const info = socketUser[socket.id];
    if (!info) return;
    const { email, roomId } = info;
    const room = rooms[roomId];
    if (room) {
      room.members = room.members.filter(m => m.socketId !== socket.id);
      io.to(roomId).emit('user-left', { socketId: socket.id, email });
      io.to(roomId).emit('member-list-update', { members: room.members });
    }
    delete socketUser[socket.id];
    console.log(`${email} disconnected from ${roomId}`);
  });

  // ── LEAVE ROOM ──
  socket.on('leave-room', ({ roomId }) => {
    const info = socketUser[socket.id];
    if (!info) return;
    socket.leave(roomId);
    const room = rooms[roomId];
    if (room) {
      room.members = room.members.filter(m => m.socketId !== socket.id);
      io.to(roomId).emit('user-left', { socketId: socket.id, email: info.email });
      io.to(roomId).emit('member-list-update', { members: room.members });
    }
    delete socketUser[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ SASTRA Study Hub server running on port ${PORT}`);
});
