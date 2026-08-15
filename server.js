require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events
} = require("discord.js");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "appointments.json");

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");

function loadAppointments() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return []; }
}
function saveAppointments(items) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2), "utf8");
}

// Las citas pendientes y confirmadas bloquean la combinación fecha + hora.
// Una cita cancelada libera ese horario para que pueda reservarse de nuevo.
function isSlotReserved(appointments, date, time) {
  return appointments.some(a =>
    a.date === date &&
    a.time === time &&
    a.status !== "cancelled"
  );
}

function normalizeSlot(date, time) {
  return {
    date: clean(date, 20),
    time: clean(time, 20)
  };
}
function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}
function nextId(items) {
  const max = items.reduce((n, a) => {
    const match = /^PB-(\d+)$/.exec(a.id || "");
    return match ? Math.max(n, Number(match[1])) : n;
  }, 0);
  return `PB-${String(max + 1).padStart(4, "0")}`;
}
function statusLabel(status) {
  return status === "confirmed" ? "🟢 CONFIRMADA" :
         status === "cancelled" ? "🔴 CANCELADA" : "🟡 PENDIENTE";
}
function buildEmbed(appointment) {
  const color = appointment.status === "confirmed" ? 0x20a464 :
                appointment.status === "cancelled" ? 0xc93c3c : 0x0d5fc4;

  const embed = new EmbedBuilder()
    .setTitle(`🩺 Cita ${appointment.id} • ${statusLabel(appointment.status)}`)
    .setColor(color)
    .addFields(
      { name: "👤 Paciente", value: appointment.name, inline: true },
      { name: "📞 Teléfono", value: appointment.phone, inline: true },
      { name: "🏥 Especialidad", value: appointment.specialty, inline: false },
      { name: "📅 Fecha", value: appointment.date, inline: true },
      { name: "🕐 Hora", value: appointment.time, inline: true },
      { name: "📝 Motivo", value: appointment.reason || "No indicado", inline: false }
    )
    .setFooter({ text: appointment.processedBy
      ? `Pillbox Medical Center • Gestionada por ${appointment.processedBy}`
      : "Pillbox Medical Center • Solicitud web" })
    .setTimestamp(new Date(appointment.createdAt));

  if (appointment.status === "pending") {
    embed.addFields({ name: "📌 Estado", value: "Pendiente de revisión por el equipo.", inline: false });
  } else {
    embed.addFields({
      name: "📌 Gestión",
      value: `${statusLabel(appointment.status)}${appointment.processedAt ? ` • ${new Date(appointment.processedAt).toLocaleString("es-ES")}` : ""}`,
      inline: false
    });
  }
  return embed;
}
function actionRow(appointment) {
  if (appointment.status !== "pending") return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`appointment:confirmed:${appointment.id}`).setLabel("Confirmada").setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId(`appointment:cancelled:${appointment.id}`).setLabel("Cancelada").setStyle(ButtonStyle.Danger).setDisabled(true)
  );
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`appointment:confirmed:${appointment.id}`).setLabel("Confirmar cita").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`appointment:cancelled:${appointment.id}`).setLabel("Cancelar cita").setEmoji("❌").setStyle(ButtonStyle.Danger)
  );
}


function adminBasicAuth(req, res, next) {
  const configuredUser = process.env.ADMIN_USER || "admin";
  const configuredPassword = process.env.ADMIN_PASSWORD;

  if (!configuredPassword) {
    return res.status(503).json({
      error: "El panel de administración no está configurado. Añade ADMIN_PASSWORD al archivo .env."
    });
  }

  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Pillbox Medical Center - Administración"');
    return res.status(401).json({ error: "Autenticación requerida." });
  }

  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const user = separator >= 0 ? decoded.slice(0, separator) : "";
    const password = separator >= 0 ? decoded.slice(separator + 1) : "";

    if (user !== configuredUser || password !== configuredPassword) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Pillbox Medical Center - Administración"');
      return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    }
  } catch {
    res.setHeader("WWW-Authenticate", 'Basic realm="Pillbox Medical Center - Administración"');
    return res.status(401).json({ error: "Credenciales inválidas." });
  }

  next();
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Discord conectado como ${readyClient.user.tag}`);
  if (!process.env.DISCORD_CHANNEL_ID) console.warn("Falta DISCORD_CHANNEL_ID en .env");
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("appointment:")) return;

  const [, newStatus, id] = interaction.customId.split(":");

  // Seguridad: solo personal autorizado puede gestionar citas.
  const staffRoleId = process.env.DISCORD_STAFF_ROLE_ID;
  const member = interaction.member;
  const hasStaffRole = staffRoleId && member?.roles?.cache?.has(staffRoleId);
  const hasManageMessages = member?.permissions?.has("ManageMessages");
  const hasAdministrator = member?.permissions?.has("Administrator");

  if (!hasStaffRole && !hasManageMessages && !hasAdministrator) {
    return interaction.reply({
      content: "⛔ No tienes permiso para gestionar citas.",
      ephemeral: true
    });
  }

  const appointments = loadAppointments();
  const appointment = appointments.find(a => a.id === id);
  if (!appointment) {
    return interaction.reply({ content: "No se encontró esa cita.", ephemeral: true });
  }
  if (appointment.status !== "pending") {
    return interaction.reply({ content: `La cita ${id} ya fue gestionada como ${statusLabel(appointment.status)}.`, ephemeral: true });
  }

  appointment.status = newStatus === "confirmed" ? "confirmed" : "cancelled";
  appointment.processedBy = interaction.user.tag;
  appointment.processedAt = new Date().toISOString();
  appointment.discordMessageId = interaction.message.id;
  saveAppointments(appointments);

  await interaction.update({
    embeds: [buildEmbed(appointment)],
    components: [actionRow(appointment)]
  });

  console.log(`Cita ${id}: ${appointment.status} por ${interaction.user.tag}`);
});

async function sendAppointmentToDiscord(appointment) {
  if (!client.isReady()) throw new Error("El bot de Discord todavía no está conectado.");
  const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) throw new Error("DISCORD_CHANNEL_ID no apunta a un canal de texto válido.");

  const message = await channel.send({
    embeds: [buildEmbed(appointment)],
    components: [actionRow(appointment)]
  });

  appointment.discordMessageId = message.id;
  const appointments = loadAppointments();
  const saved = appointments.find(a => a.id === appointment.id);
  if (saved) {
    saved.discordMessageId = message.id;
    saveAppointments(appointments);
  }
}

app.post("/api/appointments", async (req, res) => {
  try {
    if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_CHANNEL_ID) {
      return res.status(500).json({
        error: "Faltan DISCORD_BOT_TOKEN y/o DISCORD_CHANNEL_ID en el archivo .env."
      });
    }

    const body = req.body || {};
    for (const field of ["name", "phone", "specialty", "date", "time"]) {
      if (!clean(body[field])) return res.status(400).json({ error: `Falta el campo: ${field}` });
    }

    const appointments = loadAppointments();
    const slot = normalizeSlot(body.date, body.time);

    // Comprobación en el servidor: evita dos reservas para la misma fecha y hora.
    // Se hace antes de guardar la cita, por lo que la segunda solicitud recibe 409.
    if (isSlotReserved(appointments, slot.date, slot.time)) {
      return res.status(409).json({
        error: `La hora ${slot.time} del ${slot.date} ya está reservada. Elige otra hora.`
      });
    }

    const appointment = {
      id: nextId(appointments),
      name: clean(body.name, 120),
      phone: clean(body.phone, 40),
      specialty: clean(body.specialty, 100),
      date: slot.date,
      time: slot.time,
      reason: clean(body.reason, 500)
        .replace(/@everyone/gi, "@ everyone")
        .replace(/@here/gi, "@ here"),
      status: "pending",
      createdAt: new Date().toISOString(),
      processedBy: null,
      processedAt: null,
      discordMessageId: null
    };

    appointments.push(appointment);
    saveAppointments(appointments);

    try {
      await sendAppointmentToDiscord(appointment);
    } catch (discordError) {
      console.error("Discord:", discordError);
      appointment.discordError = discordError.message;
      saveAppointments(appointments);
      return res.status(502).json({
        error: "La cita se guardó, pero no se pudo enviar a Discord. Revisa la configuración del bot."
      });
    }

    return res.json({ ok: true, appointmentId: appointment.id });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Error interno al procesar la cita." });
  }
});

// Devuelve las horas ocupadas para una fecha. La web lo usa para avisar
// antes de enviar el formulario. La comprobación definitiva sigue siendo
// la del POST /api/appointments.
app.get("/api/availability", (req, res) => {
  const month = clean(req.query.month, 7);

  // Consulta mensual para el calendario: no expone datos personales,
  // solo qué fechas tienen horas ocupadas.
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: "El mes debe tener formato YYYY-MM." });
    }

    const reservedByDate = {};
    for (const appointment of loadAppointments()) {
      if (appointment.status === "cancelled" || !appointment.date.startsWith(`${month}-`)) continue;
      if (!reservedByDate[appointment.date]) reservedByDate[appointment.date] = [];
      if (!reservedByDate[appointment.date].includes(appointment.time)) {
        reservedByDate[appointment.date].push(appointment.time);
      }
    }

    return res.json({ month, reservedByDate });
  }

  const date = clean(req.query.date, 20);
  if (!date) return res.status(400).json({ error: "Falta la fecha." });

  const reservedTimes = loadAppointments()
    .filter(a => a.date === date && a.status !== "cancelled")
    .map(a => a.time);

  return res.json({ date, reservedTimes });
});

app.get("/api/appointments/:id", (req, res) => {
  const appointment = loadAppointments().find(a => a.id === req.params.id);
  if (!appointment) return res.status(404).json({ error: "Cita no encontrada." });
  // No devuelve datos personales; solo estado y número de cita.
  return res.json({ id: appointment.id, status: appointment.status });
});


app.get("/api/admin/appointments", adminBasicAuth, (req, res) => {
  const appointments = loadAppointments()
    .filter(a => a.status !== "cancelled")
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

  return res.json({
    appointments: appointments.map(a => ({
      id: a.id,
      name: a.name,
      phone: a.phone,
      specialty: a.specialty,
      date: a.date,
      time: a.time,
      reason: a.reason || "",
      status: a.status,
      createdAt: a.createdAt,
      processedBy: a.processedBy || null,
      processedAt: a.processedAt || null
    }))
  });
});


app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

client.login(process.env.DISCORD_BOT_TOKEN).catch(error => {
  console.error("No se pudo iniciar sesión con el bot de Discord:", error.message);
});

app.listen(PORT, () => {
  console.log(`Pillbox Medical Center ejecutándose en http://localhost:${PORT}`);
});
