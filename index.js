const { Server } = require("socket.io");
const express = require("express");
const http = require("http");
const moment = require("moment");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// 1. Static folder aset (CSS & JS Client)
app.use(express.static(path.join(__dirname, "public")));

// 2. Route Utama (HTML)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 3. Socket.IO (Menerima Data Real-time)
io.on("connection", (socket) => {
  console.log("Client terhubung:", socket.id);

  // Menerima data dari script di laptop/PC lokal
  socket.on("kirim_data_kwh", (data) => {
    // Teruskan ke tampilan browser yang sedang buka website
    io.emit("update-meter", data);
  });
});

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const log = (color, message) => {
  const timestamp = moment().format("DD/MM/YY HH:mm:ss");
  const timeFormatted = `\x1b[36m[${timestamp}]\x1b[0m`;

  let colorCode = "\x1b[37m"; 
  if (color === "green") colorCode = "\x1b[32m";      
  else if (color === "red") colorCode = "\x1b[31m";        
  else if (color === "yellow") colorCode = "\x1b[33m";    
  else if (color === "cyan") colorCode = "\x1b[36m";      
  else if (color === "blue") colorCode = "\x1b[34m";      

  console.log(`${timeFormatted} ${colorCode}${message}\x1b[0m`);
};

// Pengaman tambahan global untuk server
process.on('uncaughtException', (err) => {
  console.error('Ada error tidak tertangkap, server tetap aman:', err.message);
});

const areas = {
  1: "Workshop", 2: "Kompressor", 3: "LVMDB", 4: "Genset-on trigger",
  5: "DB pump wtp", 6: "DB cooling tower", 7: "DB Production 1st Floor", 8: "DB Packaging",
  9: "Lighting 1st Floor", 10: "Lighting Cold room", 11: "DB Cold room", 12: "Db Sugar Area",
  13: "Warehouse", 14: "DB Production 2st Floor", 15: "DB Filling Area", 16: "DB Horizontal",
  17: "Lighting 2nd Floor", 18: "DB Conveyor", 19: "DB Production 3rd Floor", 20: "Lighting 3rd floor", 
  21: "Tarami"
};

const latestMeterValues = {};

const simpanHistoriData = (slaveId, kwhValue, namaMeter) => {
    const tanggalHariIni = moment().format("YYYY-MM-DD");
    const waktuSekarang = moment().format("HH:mm:ss");
    const fileHistori = path.join(__dirname, "history.json");
    let dataHistori = [];

    if (fs.existsSync(fileHistori)) {
        try {
            const fileData = fs.readFileSync(fileHistori, "utf8");
            dataHistori = JSON.parse(fileData);
        } catch (err) {
            dataHistori = [];
        }
    }

    dataHistori.push({
        tanggal: tanggalHariIni, waktu: waktuSekarang, id_meter: slaveId, nama_meter: namaMeter, kwh: kwhValue
    });

    try {
        fs.writeFileSync(fileHistori, JSON.stringify(dataHistori, null, 2));
    } catch(e) {
        console.error("Gagal menulis file local storage di cloud");
    }
};

// API Endpoint untuk mengambil data histori berdasarkan tanggal
app.get("/api/history", (req, res) => {
    const fileHistori = path.join(__dirname, "history.json");
    const tanggalFilter = req.query.date;

    if (!fs.existsSync(fileHistori)) {
        return res.json([]);
    }
    try {
        const fileData = fs.readFileSync(fileHistori, "utf8");
        let dataHistori = JSON.parse(fileData);
        if (tanggalFilter) {
            dataHistori = dataHistori.filter(item => item.tanggal === tanggalFilter);
        }
        res.json(dataHistori);
    } catch (err) {
        res.json([]);
    }
});

// CRON JOB: SIMPAN OTOMATIS SETIAP HARI JAM 08:00 PAGI
cron.schedule("0 8 * * *", () => {
    log("yellow", "Menjalankan penjadwalan simpan histori harian jam 08:00...");
    for (let i = 1; i <= 21; i++) {
        if (latestMeterValues[i]) {
            simpanHistoriData(i, latestMeterValues[i].kwh, latestMeterValues[i].name);
        }
    }
    log("yellow", "Histori harian jam 08:00 berhasil direkam.");
});

// Server Listen (Wajib ditaruh paling bawah setelah semua route & API)
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  log("cyan", `Web server berjalan sukses di port: ${PORT}`);
});
