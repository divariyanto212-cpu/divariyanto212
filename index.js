const { Server } = require("socket.io");
const express = require("express");
const http = require("http");
const moment = require("moment");
const modbus = require("jsmodbus");
const { SerialPort } = require("serialport");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

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

const configuration = new SerialPort({
  path: "COM3",
  baudRate: 9600,
  parity: "none",
  stopBits: 1,
  dataBits: 8,
});

configuration.on('error', function(err) {
  log("red", "Hubungan SerialPort Gagal/Tidak Ada: " + err.message);
});

process.on('uncaughtException', (err) => {
  console.error('Ada error tidak tertangkap, server tetap aman:', err);
});


const nrgs = [1, 9];
const cvms = [2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
const areas = {
  1: "Workshop", 
  2: "Kompressor", 
  3: "LVMDB", 
  4: "Genset-on trigger",
  5: "DB pump wtp", 
  6: "DB cooling tower", 
  7: "DB Production 1st Floor", 
  8: "DB Packaging",
  9: "Lighting 1st Floor", 
  10: "Lighting Cold room", 
  11: "DB Cold room", 
  12: "Db Sugar Area",
  13: "Warehouse", 
  14: "DB Production 2st Floor", 
  15: "DB Filling Area", 
  16: "DB Horizontal",
  17: "Lighting 2nd Floor", 
  18: "DB Conveyor", 
  19: "DB Production 3rd Floor", 
  20: "Lighting 3rd floor", 
  21: "Tarami"
};

const registerConfigs = {
  cvm: { registerKwh: 0xdc, scaleKwh: 1 },
  nrg: { registerKwh: 0x3c, scaleKwh: 1000 }
};

const combineDWord = (highWord, lowWord) => {
  highWord = highWord >>> 0;
  lowWord = lowWord >>> 0;
  return highWord * 0x10000 + lowWord;
};

// Objek untuk menyimpan cache nilai kWh terakhir dari setiap meter
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
        tanggal: tanggalHariIni,
        waktu: waktuSekarang,
        id_meter: slaveId,
        nama_meter: namaMeter,
        kwh: kwhValue
    });

    fs.writeFileSync(fileHistori, JSON.stringify(dataHistori, null, 2));
};

const readRegistersWithRetry = async (client, register, numberOfRegisters, maxRetries = 3) => {
  let retries = 0;
  let lastError = null;
  while (retries < maxRetries) {
    try {
      return await client.readHoldingRegisters(register, numberOfRegisters);
    } catch (error) {
      lastError = error;
      retries++;
      await delay(1000);
    }
  }
  throw new Error(`Gagal membaca register: ${lastError.message}`);
};

const getPowerMeterKwh = async (slaveId) => {
  if (!areas[slaveId]) return;
  const deviceType = cvms.includes(slaveId) ? 'cvm' : nrgs.includes(slaveId) ? 'nrg' : null;
  if (!deviceType) return;
  
  const config = registerConfigs[deviceType];
  const client = new modbus.client.RTU(configuration, slaveId, 3000);
  
  try {
    const dataKwh = await readRegistersWithRetry(client, config.registerKwh, 2);
    const kwh = combineDWord(dataKwh.response.body.values[0], dataKwh.response.body.values[1]) / config.scaleKwh;
    const kwhFormatted = kwh.toFixed(2);
    
    // Simpan ke cache memori untuk jadwal jam 8
    latestMeterValues[slaveId] = {
        kwh: kwhFormatted,
        name: areas[slaveId]
    };

    log("green", `[${areas[slaveId]}] kWh Berhasil: ${kwhFormatted} kWh`);
    io.emit("update-meter", { id: slaveId, name: areas[slaveId], kwh: kwhFormatted, status: "success" });
  } catch (error) {
    log("red", `[${areas[slaveId]}] Gagal membaca kWh: ${error.message}`);
    io.emit("update-meter", { id: slaveId, name: areas[slaveId], kwh: "Error", status: "error" });
  }
};

// =======================================================
// CRON JOB: SIMPAN OTOMATIS SETIAP HARI JAM 08:00 PAGI
// =======================================================
cron.schedule("0 8 * * *", () => {
    log("yellow", "Menjalankan penjadwalan simpan histori harian jam 08:00...");
    for (let i = 1; i <= 21; i++) {
        if (latestMeterValues[i]) {
            simpanHistoriData(i, latestMeterValues[i].kwh, latestMeterValues[i].name);
        }
    }
    log("yellow", "Histori harian jam 08:00 berhasil direkam ke file.");
});

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

configuration.setMaxListeners(0);
configuration.on("open", async () => {
  log("cyan", "Serial port terbuka. Memulai pembacaan kWh...");
  while (true) {
    try {
      for (let i = 1; i <= 21; i++) {
        await getPowerMeterKwh(i);
        await delay(1500);
      }
      log("yellow", "Satu siklus pembacaan selesai, menunggu siklus berikutnya...");
      await delay(5000);
    } catch (cycleError) {
      log("red", `Error siklus utama: ${cycleError.message}`);
      await delay(5000);
    }
  }
});

server.listen(3000, '0.0.0.0', () => {
  log("cyan", "Web server berjalan di: http://192.168.1.248:3000");
});
