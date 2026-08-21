const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  Partials
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const dns = require('node:dns');

// Some container hosts (Railway included) advertise IPv6 support that doesn't
// actually work, which makes Node's fetch() throw an AggregateError on any
// domain with both IPv4 and IPv6 records. Preferring IPv4 first avoids that.
dns.setDefaultResultOrder('ipv4first');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// Path to the warns file on the Railway Volume (falls back to local folder if no volume is mounted)
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const WARNS_FILE = path.join(DATA_DIR, 'warns.json');

function loadWarns() {
  try {
    if (fs.existsSync(WARNS_FILE)) {
      const raw = fs.readFileSync(WARNS_FILE, 'utf8');
      return new Map(Object.entries(JSON.parse(raw)));
    }
  } catch (error) {
    console.error('Error loading warns.json, starting fresh:', error);
  }
  return new Map();
}

function saveWarns(map) {
  try {
    const obj = Object.fromEntries(map);
    fs.writeFileSync(WARNS_FILE, JSON.stringify(obj, null, 2));
  } catch (error) {
    console.error('Error saving warns.json:', error);
  }
}

// Path to the config file (stores mod-log channel per server)
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading config.json, starting fresh:', error);
  }
  return {};
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Error saving config.json:', error);
  }
}

let botConfig = loadConfig(); // { [guildId]: { modLogChannelId: "..." } }

async function sendModLog(guild, embed, options = {}) {
  const guildConfig = botConfig[guild.id];
  if (!guildConfig || !guildConfig.modLogChannelId) return;

  try {
    const channel = await guild.channels.fetch(guildConfig.modLogChannelId);
    if (channel) await channel.send({ embeds: [embed], files: options.files || [] });
  } catch (error) {
    console.error('Error sending to mod-log channel:', error);
  }
}

// Used whenever /start-stage is run without an image attached.
// Override by setting a DEFAULT_STAGE_IMAGE environment variable in Railway.
const DEFAULT_STAGE_IMAGE = process.env.DEFAULT_STAGE_IMAGE
  || 'https://placehold.co/400x400/3BA6F6/FFFFFF?text=Event+Stage';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

// Tracks warns per user, per server. Persisted to disk so it survives restarts.
// Key: "guildId-userId" -> number of warns
const warnCounts = loadWarns();

// Fallback defaults — each server can override both of these with /warn-config
const DEFAULT_WARN_LIMIT = 3;
const DEFAULT_AUTO_TIMEOUT_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

function getWarnLimit(guildId) {
  return botConfig[guildId]?.warnConfig?.limit || DEFAULT_WARN_LIMIT;
}

function getWarnTimeoutMs(guildId) {
  return botConfig[guildId]?.warnConfig?.timeoutMs || DEFAULT_AUTO_TIMEOUT_MS;
}

// Selectable timeout lengths for /warn-config and /timeout (Discord's own cap is 28 days)
const TIMEOUT_DURATION_CHOICES = [
  { name: '60 seconds', value: '60000' },
  { name: '5 minutes', value: '300000' },
  { name: '10 minutes', value: '600000' },
  { name: '1 hour', value: '3600000' },
  { name: '1 day', value: '86400000' },
  { name: '3 days', value: '259200000' },
  { name: '1 week', value: '604800000' },
  { name: '2 weeks', value: '1209600000' },
  { name: '28 days (max)', value: '2419200000' }
];

function formatDuration(ms) {
  const map = {
    60000: '60 seconds',
    300000: '5 minutes',
    600000: '10 minutes',
    3600000: '1 hour',
    86400000: '1 day',
    259200000: '3 days',
    604800000: '1 week',
    1209600000: '2 weeks',
    2419200000: '28 days'
  };
  if (map[ms]) return map[ms];
  if (ms % 86400000 === 0) return `${ms / 86400000} day(s)`;
  if (ms % 3600000 === 0) return `${ms / 3600000} hour(s)`;
  return `${Math.round(ms / 60000)} minute(s)`;
}

function modLogEmbed({ action, color, target, moderator, reason }) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(action)
    .addFields(
      { name: 'User', value: target, inline: true },
      { name: 'Moderator', value: moderator, inline: true }
    )
    .setTimestamp();

  if (reason) embed.addFields({ name: 'Reason', value: reason });
  return embed;
}

function lockStickyEmbed() {
  return new EmbedBuilder()
    .setColor(0xE74C3C)
    .setDescription('🔒 **This channel is locked.** Only staff/higher-ups can chat here.');
}

async function postLockSticky(channel) {
  try {
    const sent = await channel.send({ embeds: [lockStickyEmbed()] });
    if (!botConfig[channel.guild.id]) botConfig[channel.guild.id] = {};
    if (!botConfig[channel.guild.id].stickyMessages) botConfig[channel.guild.id].stickyMessages = {};
    botConfig[channel.guild.id].stickyMessages[channel.id] = sent.id;
    saveConfig(botConfig);
  } catch (error) {
    console.error('Error posting lock sticky message:', error);
  }
}

async function removeLockSticky(channel) {
  const guildConfig = botConfig[channel.guild.id];
  const messageId = guildConfig?.stickyMessages?.[channel.id];
  if (!messageId) return;

  delete guildConfig.stickyMessages[channel.id];
  saveConfig(botConfig);

  try {
    const oldMessage = await channel.messages.fetch(messageId);
    await oldMessage.delete();
  } catch (error) {
    // Message may already be gone — nothing to clean up
  }
}

// ---- Ticket system helpers ----
const TICKET_PANEL_BUTTON_ID = 'ticket_create_panel';
const TICKET_MODAL_ID = 'ticketCreateModal';
const TICKET_CLOSE_BUTTON_ID = 'ticket_close';

function getTicketConfig(guildId) {
  return botConfig[guildId]?.tickets;
}

function sanitizeChannelName(name) {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return (cleaned || 'user').slice(0, 90);
}

function ticketPanelEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(title || '🎫 Support Tickets')
    .setDescription(description || 'Need help? Click the button below to open a private ticket with staff.')
    .setTimestamp();
}

function ticketPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(TICKET_PANEL_BUTTON_ID).setLabel('Open a Ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary)
  );
}

function ticketChannelEmbed(opener, reason) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎫 Ticket Opened')
    .setDescription(`Thanks for reaching out, <@${opener.id}>! Staff will be with you shortly.\nClick **Close Ticket** below once this is resolved.`)
    .setTimestamp();
  if (reason) embed.addFields({ name: 'Reason', value: reason });
  return embed;
}

function ticketCloseRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(TICKET_CLOSE_BUTTON_ID).setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger)
  );
}

// Prevents a giveaway from being concluded twice (e.g. manually ended right before its
// natural timer would have fired) — not persisted, since the pending setTimeout that could
// cause a double-fire is itself lost on restart anyway.
const concludedGiveawayIds = new Set();

// Picks winners and announces them for a finished giveaway, then removes it from storage
async function concludeGiveaway(guildId, giveaway) {
  if (concludedGiveawayIds.has(giveaway.messageId)) return;
  concludedGiveawayIds.add(giveaway.messageId);

  const guildConfig = botConfig[guildId];
  if (guildConfig?.activeGiveaways) {
    guildConfig.activeGiveaways = guildConfig.activeGiveaways.filter(g => g.messageId !== giveaway.messageId);
  }

  const entrants = giveaway.entrants || [];
  const shuffled = [...entrants].sort(() => 0.5 - Math.random());
  const pickedWinners = shuffled.slice(0, giveaway.winners);

  // Keep a short history so /reroll-giveaway can find this giveaway's entrant pool later
  if (guildConfig) {
    if (!guildConfig.endedGiveaways) guildConfig.endedGiveaways = [];
    guildConfig.endedGiveaways.unshift({
      messageId: giveaway.messageId,
      channelId: giveaway.channelId,
      prize: giveaway.prize,
      winners: giveaway.winners,
      entrants,
      lastWinners: pickedWinners,
      endedAt: Date.now()
    });
    guildConfig.endedGiveaways = guildConfig.endedGiveaways.slice(0, 20);
  }
  saveConfig(botConfig);

  try {
    const channel = await client.channels.fetch(giveaway.channelId);
    const message = await channel.messages.fetch(giveaway.messageId);

    const winnersText = entrants.length === 0
      ? 'No one entered, so no winner could be picked.'
      : pickedWinners.map(id => `<@${id}>`).join(', ');

    const endedEmbed = new EmbedBuilder()
      .setColor(0x99AAB5)
      .setTitle(`🎉 Giveaway Ended: ${giveaway.prize}`)
      .setDescription(`Winner(s): ${winnersText}\nTotal entrants: ${entrants.length}`)
      .setTimestamp();

    await message.edit({ embeds: [endedEmbed], components: [] });
    if (entrants.length > 0) {
      await channel.send(`🎉 Congratulations ${winnersText}! You won **${giveaway.prize}**!`);
    }
  } catch (error) {
    console.error('Error concluding giveaway:', error);
  }
}

// Sends a reminder DM when its time is up, then removes it from disk
function scheduleReminder(reminder) {
  const remaining = reminder.fireTimestamp - Date.now();

  const fire = async () => {
    try {
      const user = await client.users.fetch(reminder.userId);
      const dmChannel = await user.createDM();
      await dmChannel.send(`⏰ Reminder: ${reminder.message}`);
    } catch (error) {
      console.error('Error sending reminder DM:', error);
    }

    if (botConfig.reminders) {
      botConfig.reminders = botConfig.reminders.filter(r => r.id !== reminder.id);
      saveConfig(botConfig);
    }
  };

  if (remaining <= 0) {
    fire();
  } else {
    setTimeout(fire, remaining);
  }
}

// Fetches live status from the free mcsrvstat.us API (no key required)
async function fetchMinecraftStatus(address, edition) {
  // The API requires a non-empty User-Agent header, and it expects any
  // address:port to keep its literal colon rather than being percent-encoded.
  const safeAddress = address.split(':').map(encodeURIComponent).join(':');
  const url = edition === 'bedrock'
    ? `https://api.mcsrvstat.us/bedrock/3/${safeAddress}`
    : `https://api.mcsrvstat.us/3/${safeAddress}`;

  console.log('Fetching Minecraft status URL:', url);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'DiscordBot (starter-discord-bot, 1.0)' }
    });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    return response.json();
  } catch (error) {
    console.error('Raw fetch error for URL', url, ':', error);
    error.debugUrl = url;
    throw error;
  }
}

function buildMcStatusEmbed(address, data) {
  const embed = new EmbedBuilder()
    .setTitle(`🎮 ${address}`)
    .setColor(data.online ? 0x2ECC71 : 0xE74C3C)
    .addFields({ name: 'Status', value: data.online ? '🟢 Online' : '🔴 Offline', inline: true })
    .setTimestamp();

  if (data.online) {
    if (data.players) {
      embed.addFields({ name: 'Players', value: `${data.players.online}/${data.players.max}`, inline: true });
    }
    if (data.version) {
      embed.addFields({ name: 'Version', value: `${data.version}`, inline: true });
    }
    if (data.motd?.clean?.length) {
      embed.addFields({ name: 'MOTD', value: data.motd.clean.join('\n') });
    }
    if (data.icon) {
      // The API returns the icon as a base64 data URI, which Discord embeds can't use directly
      // (thumbnails need a real http(s) URL) — their dedicated /icon/ endpoint gives us that instead.
      const safeAddress = address.split(':').map(encodeURIComponent).join(':');
      embed.setThumbnail(`https://api.mcsrvstat.us/icon/${safeAddress}`);
    }
  }

  return embed;
}

// Tracks active mc-watch refresh timers so they can be cleared/replaced. Not persisted —
// rebuilt automatically on startup from the saved watch config for each server.
const mcWatchIntervals = new Map();

async function refreshMcWatch(guildId) {
  const watch = botConfig[guildId]?.mcWatch;
  if (!watch) return;

  try {
    const data = await fetchMinecraftStatus(watch.address, watch.edition);
    const embed = buildMcStatusEmbed(watch.address, data);

    const channel = await client.channels.fetch(watch.channelId).catch(() => null);
    if (!channel) return;
    const message = await channel.messages.fetch(watch.messageId).catch(() => null);
    if (!message) return;

    await message.edit({ embeds: [embed] });
  } catch (error) {
    console.error(`Error refreshing mc-watch for guild ${guildId}:`, error);
  }
}

function startMcWatchInterval(guildId) {
  const existing = mcWatchIntervals.get(guildId);
  if (existing) clearInterval(existing);

  const watch = botConfig[guildId]?.mcWatch;
  if (!watch) return;

  const intervalId = setInterval(() => refreshMcWatch(guildId), watch.intervalMinutes * 60 * 1000);
  mcWatchIntervals.set(guildId, intervalId);
}

// Define slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Replies with Pong! to confirm the bot is alive'),

  new SlashCommandBuilder()
    .setName('start-stage')
    .setDescription('Start a Stage event and announce it to the server')
    .addStringOption(option =>
      option.setName('event-name')
        .setDescription('The name/topic of the event')
        .setRequired(true)
    )
    .addChannelOption(option =>
      option.setName('stage-channel')
        .setDescription('Which stage channel to start the event in')
        .addChannelTypes(ChannelType.GuildStageVoice)
        .setRequired(true)
    )
    .addAttachmentOption(option =>
      option.setName('image')
        .setDescription('Optional thumbnail image for the announcement embed')
        .setRequired(false)
    )
    .addRoleOption(option =>
      option.setName('ping-role')
        .setDescription('A role to ping (leave blank to ping @everyone instead)')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName('end-stage')
    .setDescription('End an active Stage event')
    .addChannelOption(option =>
      option.setName('stage-channel')
        .setDescription('Which stage channel to end the event in')
        .addChannelTypes(ChannelType.GuildStageVoice)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Open a form to create and send a custom embed (supports multiple lines)')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Which channel to send the embed to (defaults to this channel)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .addAttachmentOption(option =>
      option.setName('image1').setDescription('Image to include (optional)').setRequired(false)
    )
    .addAttachmentOption(option =>
      option.setName('image2').setDescription('Another image (optional)').setRequired(false)
    )
    .addAttachmentOption(option =>
      option.setName('image3').setDescription('Another image (optional)').setRequired(false)
    )
    .addAttachmentOption(option =>
      option.setName('image4').setDescription('Another image (optional)').setRequired(false)
    )
    .addAttachmentOption(option =>
      option.setName('file1').setDescription('Any file to attach (mp3, pdf, etc — optional)').setRequired(false)
    )
    .addAttachmentOption(option =>
      option.setName('file2').setDescription('Another file to attach (optional)').setRequired(false)
    )
    .addAttachmentOption(option =>
      option.setName('file3').setDescription('Another file to attach (optional)').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('dm-embed')
    .setDescription("Build an embed with many files via DM — the bot messages you to collect uploads, then zips them")
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Which channel to send the finished embed to')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('zip-name')
        .setDescription('Name for the zip file (without .zip)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('nick')
    .setDescription("Change (or reset) a member's nickname")
    .addUserOption(option =>
      option.setName('user').setDescription('The member to rename').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('nickname')
        .setDescription('New nickname (leave blank to reset to their default username)')
        .setRequired(false)
        .setMaxLength(32)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames),

  new SlashCommandBuilder()
    .setName('add-role')
    .setDescription('Add a role to a member')
    .addUserOption(option =>
      option.setName('user').setDescription('The member to give the role to').setRequired(true)
    )
    .addRoleOption(option =>
      option.setName('role').setDescription('The role to add').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  new SlashCommandBuilder()
    .setName('remove-role')
    .setDescription('Remove a role from a member')
    .addUserOption(option =>
      option.setName('user').setDescription('The member to remove the role from').setRequired(true)
    )
    .addRoleOption(option =>
      option.setName('role').setDescription('The role to remove').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Set slowmode for this (or another) channel')
    .addIntegerOption(option =>
      option.setName('seconds')
        .setDescription('Seconds between messages (0 to disable slowmode)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(21600)
    )
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Which channel (defaults to this one)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Prevent @everyone from sending messages in a channel')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Which channel (defaults to this one)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Allow @everyone to send messages in a channel again')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Which channel (defaults to this one)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription("View a member's roles, join date, and warn count")
    .addUserOption(option =>
      option.setName('user').setDescription('The member to check (defaults to you)').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Post (or refresh) a list of everything this bot can do'),

  new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Post a poll with buttons (live vote counts; resets if the bot restarts)')
    .addStringOption(option => option.setName('question').setDescription('The poll question').setRequired(true))
    .addStringOption(option => option.setName('option1').setDescription('First option').setRequired(true))
    .addStringOption(option => option.setName('option2').setDescription('Second option').setRequired(true))
    .addStringOption(option => option.setName('option3').setDescription('Third option (optional)').setRequired(false))
    .addStringOption(option => option.setName('option4').setDescription('Fourth option (optional)').setRequired(false))
    .addStringOption(option => option.setName('emoji1').setDescription('Custom emoji for option 1 (optional)').setRequired(false))
    .addStringOption(option => option.setName('emoji2').setDescription('Custom emoji for option 2 (optional)').setRequired(false))
    .addStringOption(option => option.setName('emoji3').setDescription('Custom emoji for option 3 (optional)').setRequired(false))
    .addStringOption(option => option.setName('emoji4').setDescription('Custom emoji for option 4 (optional)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('end-poll')
    .setDescription('End a poll early, lock voting, and post final results')
    .addStringOption(option =>
      option.setName('poll')
        .setDescription('Which poll to end — start typing its question to search')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName('poll-votes')
    .setDescription('See who voted for each option in a poll (only visible to you)')
    .addStringOption(option =>
      option.setName('poll')
        .setDescription('Which poll to inspect — start typing its question to search')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Start a giveaway members can enter with a button')
    .addStringOption(option => option.setName('prize').setDescription('What is being given away').setRequired(true))
    .addStringOption(option =>
      option.setName('duration')
        .setDescription('How long the giveaway runs')
        .setRequired(true)
        .addChoices(
          { name: '5 minutes', value: '300000' },
          { name: '10 minutes', value: '600000' },
          { name: '30 minutes', value: '1800000' },
          { name: '1 hour', value: '3600000' },
          { name: '6 hours', value: '21600000' },
          { name: '1 day', value: '86400000' },
          { name: '3 days', value: '259200000' },
          { name: '1 week', value: '604800000' }
        )
    )
    .addIntegerOption(option =>
      option.setName('winners').setDescription('Number of winners (default 1)').setMinValue(1).setMaxValue(20).setRequired(false)
    )
    .addStringOption(option =>
      option.setName('emoji').setDescription('Custom emoji for the join button (optional, defaults to 🎉)').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('end-giveaway')
    .setDescription('End an active giveaway early and pick winner(s) now')
    .addStringOption(option =>
      option.setName('giveaway')
        .setDescription('Which giveaway to end — start typing the prize to search')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('reroll-giveaway')
    .setDescription('Pick new winner(s) for a giveaway that already ended')
    .addStringOption(option =>
      option.setName('giveaway')
        .setDescription('Which ended giveaway to reroll — start typing the prize to search')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(option =>
      option.setName('winners')
        .setDescription('How many new winners to pick (defaults to the original winner count)')
        .setMinValue(1)
        .setMaxValue(20)
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('remind')
    .setDescription("Get a DM reminder later (lost if the bot restarts before then)")
    .addStringOption(option =>
      option.setName('duration')
        .setDescription('When to be reminded')
        .setRequired(true)
        .addChoices(
          { name: '5 minutes', value: '300000' },
          { name: '10 minutes', value: '600000' },
          { name: '30 minutes', value: '1800000' },
          { name: '1 hour', value: '3600000' },
          { name: '6 hours', value: '21600000' },
          { name: '1 day', value: '86400000' },
          { name: '1 week', value: '604800000' }
        )
    )
    .addStringOption(option => option.setName('message').setDescription('What to remind you about').setRequired(true)),

  new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('View stats about this server'),

  new SlashCommandBuilder()
    .setName('avatar')
    .setDescription("View a member's full-size avatar")
    .addUserOption(option => option.setName('user').setDescription('The member to check (defaults to you)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Submit a suggestion for the server (posts with 👍/👎 voting)')
    .addStringOption(option => option.setName('suggestion').setDescription('Your suggestion').setRequired(true)),

  new SlashCommandBuilder()
    .setName('set-suggestions-channel')
    .setDescription('Set the channel where /suggest posts go')
    .addChannelOption(option =>
      option.setName('channel').setDescription('The channel for suggestions').addChannelTypes(ChannelType.GuildText).setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('autorole')
    .setDescription('Enable/disable automatically giving new members a role when they join')
    .addBooleanOption(option => option.setName('enabled').setDescription('Turn auto-role on or off').setRequired(true))
    .addRoleOption(option => option.setName('role').setDescription('The role to auto-assign (required when enabling)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  new SlashCommandBuilder()
    .setName('mc-status')
    .setDescription('Check a Minecraft server\'s status right now')
    .addStringOption(option =>
      option.setName('address').setDescription('Server address, e.g. play.example.com or play.example.com:25566').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('edition')
        .setDescription('Java or Bedrock (defaults to Java)')
        .setRequired(false)
        .addChoices({ name: 'Java', value: 'java' }, { name: 'Bedrock', value: 'bedrock' })
    ),

  new SlashCommandBuilder()
    .setName('mc-watch')
    .setDescription('Post a live-updating Minecraft server status message')
    .addStringOption(option =>
      option.setName('address').setDescription('Server address, e.g. play.example.com or play.example.com:25566').setRequired(true)
    )
    .addChannelOption(option =>
      option.setName('channel').setDescription('Which channel (defaults to this one)').addChannelTypes(ChannelType.GuildText).setRequired(false)
    )
    .addIntegerOption(option =>
      option.setName('interval-minutes').setDescription('How often to refresh, in minutes (default 5, min 1)').setMinValue(1).setMaxValue(60).setRequired(false)
    )
    .addStringOption(option =>
      option.setName('edition')
        .setDescription('Java or Bedrock (defaults to Java)')
        .setRequired(false)
        .addChoices({ name: 'Java', value: 'java' }, { name: 'Bedrock', value: 'bedrock' })
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('mc-unwatch')
    .setDescription('Stop the live Minecraft server status updates')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member from the server')
    .addUserOption(option =>
      option.setName('user').setDescription('The member to kick').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('reason').setDescription('Reason for the kick').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member from the server')
    .addUserOption(option =>
      option.setName('user').setDescription('The member to ban').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('reason').setDescription('Reason for the ban').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user by their user ID')
    .addStringOption(option =>
      option.setName('user-id').setDescription('The user ID to unban').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Timeout (mute) a member for a set duration')
    .addUserOption(option =>
      option.setName('user').setDescription('The member to timeout').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('duration')
        .setDescription('How long to timeout the member')
        .setRequired(true)
        .addChoices(...TIMEOUT_DURATION_CHOICES)
    )
    .addStringOption(option =>
      option.setName('reason').setDescription('Reason for the timeout').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a member (auto-timeout once they hit the configured warn limit)')
    .addUserOption(option =>
      option.setName('user').setDescription('The member to warn').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('reason').setDescription('Reason for the warning').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('warn-config')
    .setDescription('View or set this server\'s warn limit and auto-timeout duration')
    .addIntegerOption(option =>
      option.setName('limit')
        .setDescription('Warns needed before auto-timeout (default 3)')
        .setMinValue(1)
        .setMaxValue(20)
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('timeout-duration')
        .setDescription('How long the auto-timeout lasts (default 3 days)')
        .setRequired(false)
        .addChoices(...TIMEOUT_DURATION_CHOICES)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('warnings')
    .setDescription("View a member's current warn count")
    .addUserOption(option =>
      option.setName('user').setDescription('The member to check').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('set-modlog')
    .setDescription('Set the channel where moderation actions get logged')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('The channel to send mod-log messages to')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('remove-warn')
    .setDescription("Remove one warn from a member's count")
    .addUserOption(option =>
      option.setName('user').setDescription('The member to remove a warn from').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('clear-warnings')
    .setDescription("Reset a member's warn count to 0")
    .addUserOption(option =>
      option.setName('user').setDescription('The member to clear warns for').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription("Remove an active timeout from a member")
    .addUserOption(option =>
      option.setName('user').setDescription('The member to remove the timeout from').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Mass delete messages from this channel (with confirmation)')
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Number of messages to delete (leave blank if using "all")')
        .setMinValue(1)
        .setMaxValue(1000)
        .setRequired(false)
    )
    .addBooleanOption(option =>
      option.setName('all')
        .setDescription('Delete ALL messages in this channel')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('ticket-setup')
    .setDescription('Configure the ticket system for this server')
    .addChannelOption(option =>
      option.setName('category')
        .setDescription('Category new ticket channels get created under')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(true)
    )
    .addRoleOption(option =>
      option.setName('support-role')
        .setDescription('Role that can see and manage all tickets')
        .setRequired(true)
    )
    .addChannelOption(option =>
      option.setName('log-channel')
        .setDescription('Where ticket transcripts get sent when closed (defaults to mod-log)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('Post the "Open a Ticket" button panel in a channel')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Channel to post the panel in (defaults to this one)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('title').setDescription('Panel title (optional)').setRequired(false)
    )
    .addStringOption(option =>
      option.setName('description').setDescription('Panel description (optional)').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
].map(command => command.toJSON());

// Register the slash commands with Discord
const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
    console.log('Slash commands registered successfully.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
})();

// Builds the always-current command list embed from the live `commands` array
function buildHelpEmbed() {
  const lines = commands
    .map(cmd => `**/${cmd.name}** — ${cmd.description}`)
    .join('\n');

  return new EmbedBuilder()
    .setColor(0x800080)
    .setTitle('📖 Bot Commands')
    .setDescription(lines)
    .setFooter({ text: 'This message auto-updates whenever the bot is redeployed with new/changed commands.' })
    .setTimestamp();
}

// When the bot is ready
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}. Bot is online!`);

  // Auto-refresh any previously posted /help messages with the current command list
  for (const guildId of Object.keys(botConfig)) {
    const helpMessage = botConfig[guildId]?.helpMessage;
    if (!helpMessage) continue;

    try {
      const channel = await client.channels.fetch(helpMessage.channelId).catch(() => null);
      if (!channel) continue;
      const message = await channel.messages.fetch(helpMessage.messageId).catch(() => null);
      if (!message) continue;

      await message.edit({ embeds: [buildHelpEmbed()] });
      console.log(`Refreshed help message for guild ${guildId}`);
    } catch (error) {
      console.error(`Error refreshing help message for guild ${guildId}:`, error);
    }
  }

  // Reschedule (or immediately conclude) any giveaways that were running before this restart
  for (const guildId of Object.keys(botConfig)) {
    const activeGiveaways = botConfig[guildId]?.activeGiveaways || [];
    for (const giveaway of activeGiveaways) {
      const remaining = giveaway.endTimestamp - Date.now();
      if (remaining <= 0) {
        concludeGiveaway(guildId, giveaway);
      } else {
        setTimeout(() => concludeGiveaway(guildId, giveaway), remaining);
      }
    }
  }

  // Rebuild in-memory poll vote state from disk
  for (const [token, saved] of Object.entries(botConfig.polls || {})) {
    pollState.set(token, {
      question: saved.question,
      authorTag: saved.authorTag,
      authorId: saved.authorId,
      guildId: saved.guildId,
      channelId: saved.channelId,
      messageId: saved.messageId,
      closed: !!saved.closed,
      options: saved.options.map(opt => ({ label: opt.label, emoji: opt.emoji, voters: new Set(opt.voters) }))
    });
  }
  console.log(`Restored ${Object.keys(botConfig.polls || {}).length} poll(s) from disk.`);

  // Reschedule any reminders that were pending before this restart
  for (const reminder of botConfig.reminders || []) {
    scheduleReminder(reminder);
  }
  console.log(`Restored ${(botConfig.reminders || []).length} reminder(s) from disk.`);

  // Resume any active mc-watch live status timers
  let mcWatchCount = 0;
  for (const guildId of Object.keys(botConfig)) {
    if (botConfig[guildId]?.mcWatch) {
      startMcWatchInterval(guildId);
      refreshMcWatch(guildId); // refresh immediately so the status isn't stale after a restart
      mcWatchCount++;
    }
  }
  console.log(`Resumed ${mcWatchCount} mc-watch timer(s).`);
});

// Temporarily holds image URLs between /embed being run and the modal being submitted
const pendingEmbedImages = new Map();

// Discord modals expire 15 minutes after being shown, so any pending entry older than that
// can never be submitted — clean those up periodically to avoid a slow memory leak on a
// long-running bot (e.g. from people who open /embed or /dm-embed and never submit the modal).
const PENDING_EMBED_TTL_MS = 15 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - PENDING_EMBED_TTL_MS;
  for (const [token, pending] of pendingEmbedImages.entries()) {
    if ((pending.createdAt || 0) < cutoff) pendingEmbedImages.delete(token);
  }
}, 5 * 60 * 1000);

// Holds live vote state for button-based polls, mirrored to disk so it survives restarts.
const pollState = new Map();

function buildPollDescription(options, closed = false) {
  const totalVotes = options.reduce((sum, opt) => sum + opt.voters.size, 0);
  const maxVotes = closed ? Math.max(...options.map(o => o.voters.size)) : -1;

  return options.map(opt => {
    const isWinner = closed && totalVotes > 0 && opt.voters.size === maxVotes;
    const prefix = isWinner ? '🏆 ' : '';
    return `${prefix}${opt.emoji} **${opt.label}** — ${opt.voters.size} vote(s)`;
  }).join('\n\n');
}

function persistPoll(token, poll) {
  if (!botConfig.polls) botConfig.polls = {};
  botConfig.polls[token] = {
    question: poll.question,
    authorTag: poll.authorTag,
    authorId: poll.authorId,
    guildId: poll.guildId,
    channelId: poll.channelId,
    messageId: poll.messageId,
    closed: !!poll.closed,
    options: poll.options.map(opt => ({ label: opt.label, emoji: opt.emoji, voters: [...opt.voters] }))
  };
  saveConfig(botConfig);
}

client.on('interactionCreate', async interaction => {
  // Handle poll vote button clicks
  if (interaction.isButton() && interaction.customId.startsWith('pollvote:')) {
    const [, token, optionIndexStr] = interaction.customId.split(':');
    const poll = pollState.get(token);

    if (!poll) {
      await interaction.reply({ content: "This poll's vote data was lost — please start a new poll.", ephemeral: true });
      return;
    }

    if (poll.closed) {
      await interaction.reply({ content: 'This poll has ended — votes are no longer being accepted.', ephemeral: true });
      return;
    }

    const optionIndex = parseInt(optionIndexStr, 10);

    // Remove this user's vote from every option, then add it to the one they just clicked
    poll.options.forEach(opt => opt.voters.delete(interaction.user.id));
    poll.options[optionIndex].voters.add(interaction.user.id);
    persistPoll(token, poll);

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`📊 ${poll.question}`)
      .setDescription(buildPollDescription(poll.options))
      .setFooter({ text: `Poll started by ${poll.authorTag}` })
      .setTimestamp();

    await interaction.update({ embeds: [embed] });

    sendModLog(interaction.guild, modLogEmbed({
      action: '📊 Poll Vote', color: 0x5865F2,
      target: poll.options[optionIndex].label, moderator: interaction.user.tag,
      reason: `Poll: "${poll.question}"`
    }));
    return;
  }

  // Handle giveaway join button clicks
  if (interaction.isButton() && interaction.customId.startsWith('giveawayjoin:')) {
    const messageId = interaction.customId.split(':')[1];
    const guildConfig = botConfig[interaction.guild.id];
    const giveaway = guildConfig?.activeGiveaways?.find(g => g.messageId === messageId);

    if (!giveaway) {
      await interaction.reply({ content: "This giveaway has already ended.", ephemeral: true });
      return;
    }

    if (!giveaway.entrants) giveaway.entrants = [];
    const alreadyIn = giveaway.entrants.includes(interaction.user.id);

    if (alreadyIn) {
      giveaway.entrants = giveaway.entrants.filter(id => id !== interaction.user.id);
    } else {
      giveaway.entrants.push(interaction.user.id);
    }
    saveConfig(botConfig);

    const embed = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setTitle(`🎉 Giveaway: ${giveaway.prize}`)
      .setDescription(`React with the button below to enter!\nEnds: <t:${Math.floor(giveaway.endTimestamp / 1000)}:R>\nWinners: **${giveaway.winners}**\nEntrants: **${giveaway.entrants.length}**`)
      .setFooter({ text: `Giveaway ID: ${messageId}` })
      .setTimestamp();

    await interaction.update({ embeds: [embed] });
    await interaction.followUp({ content: alreadyIn ? "You've left the giveaway." : "You're entered! Good luck 🍀", ephemeral: true });

    sendModLog(interaction.guild, modLogEmbed({
      action: alreadyIn ? '🎉 Giveaway Left' : '🎉 Giveaway Entered', color: 0xF1C40F,
      target: giveaway.prize, moderator: interaction.user.tag
    }));
    return;
  }

  // Handle the "Open a Ticket" panel button
  if (interaction.isButton() && interaction.customId === TICKET_PANEL_BUTTON_ID) {
    const ticketConfig = getTicketConfig(interaction.guild.id);
    if (!ticketConfig || !ticketConfig.categoryId || !ticketConfig.supportRoleId) {
      await interaction.reply({ content: "Ticket system isn't set up yet — ask an admin to run `/ticket-setup`.", ephemeral: true });
      return;
    }

    const existingChannelId = ticketConfig.openByUser?.[interaction.user.id];
    if (existingChannelId) {
      const existingChannel = await interaction.guild.channels.fetch(existingChannelId).catch(() => null);
      if (existingChannel) {
        await interaction.reply({ content: `You already have an open ticket: <#${existingChannel.id}>`, ephemeral: true });
        return;
      }
      // Stale reference — channel is gone, clean it up so they can open a new one
      delete ticketConfig.openByUser[interaction.user.id];
      saveConfig(botConfig);
    }

    const modal = new ModalBuilder()
      .setCustomId(TICKET_MODAL_ID)
      .setTitle('Open a Ticket');

    const reasonInput = new TextInputBuilder()
      .setCustomId('ticketReason')
      .setLabel('What do you need help with?')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(500);

    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
    await interaction.showModal(modal);
    return;
  }

  // Handle ticket creation modal submission
  if (interaction.isModalSubmit() && interaction.customId === TICKET_MODAL_ID) {
    await interaction.deferReply({ ephemeral: true });
    const ticketConfig = getTicketConfig(interaction.guild.id);

    if (!ticketConfig || !ticketConfig.categoryId || !ticketConfig.supportRoleId) {
      await interaction.editReply("Ticket system isn't set up yet — ask an admin to run `/ticket-setup`.");
      return;
    }

    const existingChannelId = ticketConfig.openByUser?.[interaction.user.id];
    if (existingChannelId) {
      const existingChannel = await interaction.guild.channels.fetch(existingChannelId).catch(() => null);
      if (existingChannel) {
        await interaction.editReply(`You already have an open ticket: <#${existingChannel.id}>`);
        return;
      }
      delete ticketConfig.openByUser[interaction.user.id];
    }

    const reason = interaction.fields.getTextInputValue('ticketReason') || null;
    ticketConfig.counter = (ticketConfig.counter || 0) + 1;

    try {
      const channelName = sanitizeChannelName(`ticket-${ticketConfig.counter}-${interaction.user.username}`);

      const ticketChannel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: ticketConfig.categoryId,
        permissionOverwrites: [
          { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          { id: ticketConfig.supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] }
        ]
      });

      ticketConfig.openByUser[interaction.user.id] = ticketChannel.id;
      ticketConfig.data[ticketChannel.id] = { userId: interaction.user.id, openedAt: Date.now(), reason };
      saveConfig(botConfig);

      await ticketChannel.send({
        content: `<@${interaction.user.id}> <@&${ticketConfig.supportRoleId}>`,
        embeds: [ticketChannelEmbed(interaction.user, reason)],
        components: [ticketCloseRow()]
      });

      await interaction.editReply(`✅ Ticket created: <#${ticketChannel.id}>`);
      sendModLog(interaction.guild, modLogEmbed({
        action: '🎫 Ticket Opened', color: 0x5865F2,
        target: `#${ticketChannel.name}`, moderator: interaction.user.tag,
        reason: reason || 'No reason given'
      }));
    } catch (error) {
      console.error('Error creating ticket channel:', error);
      await interaction.editReply("Couldn't create your ticket channel. Make sure I have the **Manage Channels** permission.");
    }
    return;
  }

  // Handle the "Close Ticket" button
  if (interaction.isButton() && interaction.customId === TICKET_CLOSE_BUTTON_ID) {
    const ticketConfig = getTicketConfig(interaction.guild.id);
    const ticketData = ticketConfig?.data?.[interaction.channel.id];

    const isSupport = (ticketConfig?.supportRoleId && interaction.member.roles.cache.has(ticketConfig.supportRoleId))
      || interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);
    const isOpener = ticketData?.userId === interaction.user.id;

    if (!isSupport && !isOpener) {
      await interaction.reply({ content: "You don't have permission to close this ticket.", ephemeral: true });
      return;
    }

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_close_confirm').setLabel('Confirm Close').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('ticket_close_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );

    const confirmMsg = await interaction.reply({
      content: '⚠️ Close this ticket? A transcript will be saved and this channel will be deleted.',
      components: [confirmRow],
      fetchReply: true
    });

    let buttonInteraction;
    try {
      buttonInteraction = await confirmMsg.awaitMessageComponent({
        filter: i => i.user.id === interaction.user.id,
        time: 15000
      });
    } catch {
      await interaction.editReply({ content: 'Close cancelled (confirmation timed out).', components: [] });
      return;
    }

    if (buttonInteraction.customId === 'ticket_close_cancel') {
      await buttonInteraction.update({ content: 'Close cancelled.', components: [] });
      return;
    }

    await buttonInteraction.update({ content: '🔒 Closing ticket and saving transcript...', components: [] });

    try {
      // Fetch full message history (oldest -> newest) for the transcript
      const transcriptLines = [];
      let beforeId;
      let keepGoing = true;
      while (keepGoing) {
        const fetched = await interaction.channel.messages.fetch({ limit: 100, ...(beforeId ? { before: beforeId } : {}) });
        if (fetched.size === 0) break;
        const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        for (const msg of sorted) {
          const author = msg.author ? msg.author.tag : 'Unknown user';
          const time = new Date(msg.createdTimestamp).toISOString();
          const content = msg.content && msg.content.length > 0 ? msg.content : '[no text content — embed, attachment, or system message]';
          transcriptLines.unshift(`[${time}] ${author}: ${content}`);
        }
        beforeId = fetched.last().id;
        if (fetched.size < 100) keepGoing = false;
      }

      const transcriptText = transcriptLines.length > 0 ? transcriptLines.join('\n') : '(No messages captured.)';
      const transcriptFile = new AttachmentBuilder(
        Buffer.from(transcriptText, 'utf8'),
        { name: `ticket-${interaction.channel.name}-${Date.now()}.txt` }
      );

      const openerId = ticketData?.userId;
      const logChannelId = ticketConfig?.logChannelId || botConfig[interaction.guild.id]?.modLogChannelId;

      if (logChannelId) {
        const logChannel = await interaction.guild.channels.fetch(logChannelId).catch(() => null);
        if (logChannel) {
          await logChannel.send({
            embeds: [modLogEmbed({
              action: '🔒 Ticket Closed', color: 0x95A5A6,
              target: openerId ? `<@${openerId}>` : 'Unknown user',
              moderator: interaction.user.tag,
              reason: `#${interaction.channel.name}`
            })],
            files: [transcriptFile]
          });
        }
      }

      if (ticketConfig) {
        if (openerId) delete ticketConfig.openByUser[openerId];
        delete ticketConfig.data[interaction.channel.id];
        saveConfig(botConfig);
      }

      await interaction.channel.delete();
    } catch (error) {
      console.error('Error closing ticket:', error);
      await interaction.followUp({ content: "Something went wrong closing this ticket — check my permissions (Manage Channels, Read Message History).", ephemeral: true });
    }
    return;
  }

  // Handle the embed modal submission
  if (interaction.isModalSubmit() && interaction.customId.startsWith('embedModal')) {
    const title = interaction.fields.getTextInputValue('embedTitle');
    const description = interaction.fields.getTextInputValue('embedDescription');
    const colorInput = interaction.fields.getTextInputValue('embedColor');
    const token = interaction.customId.split(':')[1];

    const pending = pendingEmbedImages.get(token) || { images: [], files: [], channelId: null };
    pendingEmbedImages.delete(token);

    let color = 0x5865F2; // default Discord blurple
    if (colorInput && /^#?[0-9A-Fa-f]{6}$/.test(colorInput.trim())) {
      color = parseInt(colorInput.trim().replace('#', ''), 16);
    }

    const mainEmbed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(color)
      .setTimestamp();

    const embeds = [mainEmbed];

    if (pending.images.length > 0) {
      // Giving every embed the same .setURL() makes Discord group the images
      // into a clean grid instead of stacking them as separate blocks.
      const groupUrl = `https://embed-gallery.local/${token}`;
      mainEmbed.setURL(groupUrl);
      mainEmbed.setImage(pending.images[0]);

      for (let i = 1; i < pending.images.length; i++) {
        embeds.push(new EmbedBuilder().setURL(groupUrl).setImage(pending.images[i]).setColor(color));
      }
    }

    // Non-image files (mp3, pdf, etc.) get re-downloaded and attached as normal
    // Discord file attachments — they show below the embed with their own
    // play button / download icon, since embeds can only display images.
    const filesToSend = [];
    for (const file of pending.files) {
      try {
        const response = await fetch(file.url);
        const arrayBuffer = await response.arrayBuffer();
        filesToSend.push(new AttachmentBuilder(Buffer.from(arrayBuffer), { name: file.name }));
      } catch (error) {
        console.error(`Error re-fetching attachment ${file.name}:`, error);
      }
    }

    try {
      const targetChannel = pending.channelId ? await client.channels.fetch(pending.channelId) : interaction.channel;
      await targetChannel.send({ embeds, files: filesToSend });
      await interaction.reply({ content: `Embed sent to <#${targetChannel.id}>.`, ephemeral: true });
    } catch (error) {
      console.error('Error sending embed:', error);
      await interaction.reply({ content: "Couldn't send the embed. Check the bot's permissions in that channel.", ephemeral: true });
    }
    return;
  }

  // Handle the dm-embed modal submission — builds the embed, then starts DM file collection
  if (interaction.isModalSubmit() && interaction.customId.startsWith('dmEmbedModal')) {
    const title = interaction.fields.getTextInputValue('embedTitle');
    const description = interaction.fields.getTextInputValue('embedDescription');
    const colorInput = interaction.fields.getTextInputValue('embedColor');
    const token = interaction.customId.split(':')[1];

    const pending = pendingEmbedImages.get(token);
    pendingEmbedImages.delete(token);

    if (!pending) {
      await interaction.reply({ content: "Something went wrong — that session expired. Please run /dm-embed again.", ephemeral: true });
      return;
    }

    let color = 0x5865F2;
    if (colorInput && /^#?[0-9A-Fa-f]{6}$/.test(colorInput.trim())) {
      color = parseInt(colorInput.trim().replace('#', ''), 16);
    }

    await interaction.reply({ content: "📬 Check your DMs — I've sent you instructions for uploading files.", ephemeral: true });

    let dmChannel;
    try {
      dmChannel = await interaction.user.createDM();
      await dmChannel.send(
        `📎 Send me the files you want zipped and attached to your embed for **${title}**.\n` +
        `You can send them one at a time or several per message. Type **done** when finished (or I'll auto-finish after 5 minutes).`
      );
    } catch (error) {
      console.error('Error opening DM channel:', error);
      await interaction.followUp({ content: "I couldn't DM you — make sure your DMs are open to server members and try again.", ephemeral: true });
      return;
    }

    const collectedFiles = [];

    const collector = dmChannel.createMessageCollector({
      filter: msg => msg.author.id === interaction.user.id,
      time: 5 * 60 * 1000 // 5 minutes
    });

    collector.on('collect', async msg => {
      if (msg.content.trim().toLowerCase() === 'done') {
        collector.stop('done');
        return;
      }

      if (msg.attachments.size > 0) {
        for (const attachment of msg.attachments.values()) {
          collectedFiles.push({ url: attachment.url, name: attachment.name });
        }
        await dmChannel.send(`Got it — ${msg.attachments.size} file(s) added (${collectedFiles.length} total so far). Send more, or type **done**.`);
      }
    });

    collector.on('end', async () => {
      if (collectedFiles.length === 0) {
        await dmChannel.send("No files were received, so I didn't create the embed. Run the command again if you'd like to retry.");
        return;
      }

      await dmChannel.send(`⏳ Zipping ${collectedFiles.length} file(s) and posting your embed...`);

      const zip = new JSZip();
      for (const file of collectedFiles) {
        try {
          const response = await fetch(file.url);
          const arrayBuffer = await response.arrayBuffer();
          zip.file(file.name, Buffer.from(arrayBuffer));
        } catch (error) {
          console.error(`Error fetching ${file.name} for zip:`, error);
        }
      }

      try {
        const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
        const zipAttachment = new AttachmentBuilder(zipBuffer, { name: `${pending.zipName}.zip` });

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription(description)
          .setColor(color)
          .setFooter({ text: `${collectedFiles.length} file(s) attached as ${pending.zipName}.zip` })
          .setTimestamp();

        const targetChannel = await client.channels.fetch(pending.channelId);
        await targetChannel.send({ embeds: [embed], files: [zipAttachment] });
        await dmChannel.send(`✅ Done! Posted in <#${pending.channelId}>.`);
      } catch (error) {
        console.error('Error building/sending zip:', error);
        await dmChannel.send("Something went wrong while zipping or sending the files — they may be too large combined (Discord's limit is 25MB per upload on most servers).");
      }
    });

    return;
  }

  // Autocomplete for the poll picker on /end-poll and /poll-votes
  if (interaction.isAutocomplete() && (interaction.commandName === 'end-poll' || interaction.commandName === 'poll-votes')) {
    const focused = interaction.options.getFocused().toLowerCase();

    let guildPolls = [...pollState.entries()]
      .filter(([, p]) => !p.guildId || p.guildId === interaction.guildId);

    if (interaction.commandName === 'end-poll') {
      guildPolls = guildPolls.filter(([, p]) => !p.closed);
    }

    const matches = guildPolls
      .filter(([, p]) => p.question.toLowerCase().includes(focused))
      .slice(0, 25)
      .map(([, p]) => {
        const totalVotes = p.options.reduce((sum, opt) => sum + opt.voters.size, 0);
        const status = p.closed ? 'Closed' : 'Open';
        let name = `[${status}] ${p.question} (${totalVotes} vote${totalVotes === 1 ? '' : 's'})`;
        if (name.length > 100) name = name.slice(0, 97) + '...';
        return { name, value: p.messageId };
      });

    await interaction.respond(matches);
    return;
  }

  // Autocomplete for the giveaway picker on /end-giveaway and /reroll-giveaway
  if (interaction.isAutocomplete() && (interaction.commandName === 'end-giveaway' || interaction.commandName === 'reroll-giveaway')) {
    const focused = interaction.options.getFocused().toLowerCase();
    const guildConfig = botConfig[interaction.guildId];

    const pool = interaction.commandName === 'end-giveaway'
      ? (guildConfig?.activeGiveaways || []).map(g => ({
          messageId: g.messageId,
          label: `${g.prize} (${(g.entrants || []).length} entrant(s), ends <t:${Math.floor(g.endTimestamp / 1000)}:R>)`
        }))
      : (guildConfig?.endedGiveaways || []).map(g => ({
          messageId: g.messageId,
          label: `${g.prize} (ended, ${g.entrants.length} entrant(s))`
        }));

    const matches = pool
      .filter(g => g.label.toLowerCase().includes(focused))
      .slice(0, 25)
      .map(g => ({
        name: g.label.length > 100 ? g.label.slice(0, 97) + '...' : g.label,
        value: g.messageId
      }));

    await interaction.respond(matches);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // /embed - opens a form with a multi-line description box
  if (interaction.commandName === 'embed') {
    const targetChannel = interaction.options.getChannel('channel');
    const images = ['image1', 'image2', 'image3', 'image4']
      .map(name => interaction.options.getAttachment(name))
      .filter(Boolean)
      .map(attachment => attachment.url);
    const files = ['file1', 'file2', 'file3']
      .map(name => interaction.options.getAttachment(name))
      .filter(Boolean)
      .map(attachment => ({ url: attachment.url, name: attachment.name }));

    const token = interaction.id;
    pendingEmbedImages.set(token, {
      images,
      files,
      channelId: targetChannel ? targetChannel.id : null,
      createdAt: Date.now()
    });

    const modal = new ModalBuilder()
      .setCustomId(`embedModal:${token}`)
      .setTitle('Create Embed');

    const titleInput = new TextInputBuilder()
      .setCustomId('embedTitle')
      .setLabel('Embed Title')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(256);

    const descriptionInput = new TextInputBuilder()
      .setCustomId('embedDescription')
      .setLabel('Embed Description (multi-line supported)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(4000);

    const colorInput = new TextInputBuilder()
      .setCustomId('embedColor')
      .setLabel('Hex color (optional, e.g. FF0000)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(7);

    modal.addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(descriptionInput),
      new ActionRowBuilder().addComponents(colorInput)
    );

    await interaction.showModal(modal);
    return;
  }

  // /dm-embed - opens the same style modal, but collects files via DM afterward
  if (interaction.commandName === 'dm-embed') {
    const targetChannel = interaction.options.getChannel('channel');
    const zipName = interaction.options.getString('zip-name').replace(/[^a-zA-Z0-9-_ ]/g, '').trim() || 'files';

    const token = interaction.id;
    pendingEmbedImages.set(token, {
      images: [],
      files: [],
      channelId: targetChannel.id,
      zipName,
      dmUserId: interaction.user.id,
      createdAt: Date.now()
    });

    const modal = new ModalBuilder()
      .setCustomId(`dmEmbedModal:${token}`)
      .setTitle('Create Embed (files via DM)');

    const titleInput = new TextInputBuilder()
      .setCustomId('embedTitle')
      .setLabel('Embed Title')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(256);

    const descriptionInput = new TextInputBuilder()
      .setCustomId('embedDescription')
      .setLabel('Embed Description (multi-line supported)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(4000);

    const colorInput = new TextInputBuilder()
      .setCustomId('embedColor')
      .setLabel('Hex color (optional, e.g. FF0000)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(7);

    modal.addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(descriptionInput),
      new ActionRowBuilder().addComponents(colorInput)
    );

    await interaction.showModal(modal);
    return;
  }

  // /ping
  if (interaction.commandName === 'ping') {
    const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
    const roundTripLatency = sent.createdTimestamp - interaction.createdTimestamp;
    const apiLatency = Math.round(client.ws.ping);

    await interaction.editReply(
      `🏓 Pong!\nRoundtrip latency: **${roundTripLatency}ms**\nAPI latency: **${apiLatency}ms**`
    );
    return;
  }

  // /start-stage
  if (interaction.commandName === 'start-stage') {
    await interaction.deferReply({ ephemeral: true });

    const eventName = interaction.options.getString('event-name');
    const stageChannel = interaction.options.getChannel('stage-channel');
    const image = interaction.options.getAttachment('image');

    const pingRole = interaction.options.getRole('ping-role');

    const pingContent = pingRole ? `<@&${pingRole.id}>` : '@everyone';

    const allowedMentions = pingRole
      ? { roles: [pingRole.id] }
      : { parse: ['everyone'] };

    try {
      // Create the stage instance (this opens/starts the Stage)
      await stageChannel.createStageInstance({
        topic: eventName,
        privacyLevel: 2 // GUILD_ONLY
      });

      const embed = new EmbedBuilder()
        .setColor(0x3BA6F6)
        .setDescription(`# ${eventName}`)
        .addFields(
          { name: 'Stage Channel', value: `<#${stageChannel.id}>
           IP: <#1515097005137985730>`, inline: true },
          { name: '\u200B', value: '🎙️ 🔴 **Event Stage — Live**' }
        )
        .setFooter({
          text: `Started by ${interaction.user.tag}`,
          iconURL: interaction.user.displayAvatarURL()
        })
        .setTimestamp();

      embed.setThumbnail(image ? image.url : DEFAULT_STAGE_IMAGE);

      await interaction.channel.send({
        content: pingContent,
        embeds: [embed],
        allowedMentions: allowedMentions
      });

      await interaction.editReply(`Stage event **${eventName}** started in <#${stageChannel.id}> and announced.`);
    } catch (error) {
      console.error('Error starting stage:', error);
      await interaction.editReply(
        `Couldn't start the stage. Make sure the bot has **Manage Channels** and **Mention Everyone** permissions, and that <#${stageChannel.id}> doesn't already have an active stage.`
      );
    }
    return;
  }

  // /end-stage
  if (interaction.commandName === 'end-stage') {
    await interaction.deferReply({ ephemeral: true });

    const stageChannel = interaction.options.getChannel('stage-channel');

    try {
      const stageInstance = await interaction.guild.stageInstances.fetch(stageChannel.id).catch(() => null);

      if (!stageInstance) {
        await interaction.editReply(`There's no active stage event in <#${stageChannel.id}>.`);
        return;
      }

      const endedTopic = stageInstance.topic;
      await stageInstance.delete();

      const embed = new EmbedBuilder()
        .setColor(0x99AAB5)
        .setTitle(endedTopic)
        .addFields(
          { name: 'Stage Channel', value: `<#${stageChannel.id}>`, inline: true },
          { name: '\u200B', value: '🎙️ ⚫ **Event Stage — Ended**' }
        )
        .setFooter({
          text: `Ended by ${interaction.user.tag}`,
          iconURL: interaction.user.displayAvatarURL()
        })
        .setTimestamp();

      await interaction.channel.send({ embeds: [embed] });
      await interaction.editReply(`Stage event ended in <#${stageChannel.id}>.`);
    } catch (error) {
      console.error('Error ending stage:', error);
      await interaction.editReply(
        `Couldn't end the stage. Make sure the bot has **Manage Channels** permission.`
      );
    }
    return;
  }

  // /nick
  if (interaction.commandName === 'nick') {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const newNickname = interaction.options.getString('nickname'); // null if blank

    try {
      const member = await interaction.guild.members.fetch(targetUser.id);

      if (!member.manageable) {
        await interaction.editReply("I can't change that member's nickname — they may have a higher role than me.");
        return;
      }

      await member.setNickname(newNickname, `Changed by ${interaction.user.tag}`);

      const resultMessage = newNickname
        ? `✏️ Changed **${targetUser.tag}**'s nickname to **${newNickname}**.`
        : `✏️ Reset **${targetUser.tag}**'s nickname to their default username.`;

      await interaction.editReply(resultMessage);
      sendModLog(interaction.guild, modLogEmbed({
        action: '✏️ Nickname Changed', color: 0x5DADE2,
        target: targetUser.tag, moderator: interaction.user.tag,
        reason: newNickname ? `New nickname: ${newNickname}` : 'Reset to default'
      }));
    } catch (error) {
      console.error('Error changing nickname:', error);
      await interaction.editReply("Couldn't change that member's nickname. Make sure I have the **Manage Nicknames** permission.");
    }
    return;
  }

  // /add-role
  if (interaction.commandName === 'add-role') {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const role = interaction.options.getRole('role');

    try {
      const member = await interaction.guild.members.fetch(targetUser.id);

      if (role.position >= interaction.guild.members.me.roles.highest.position) {
        await interaction.editReply("I can't assign that role — it's higher than or equal to my own highest role.");
        return;
      }
      if (member.roles.cache.has(role.id)) {
        await interaction.editReply(`**${targetUser.tag}** already has the **${role.name}** role.`);
        return;
      }

      await member.roles.add(role);
      await interaction.editReply(`✅ Gave **${role.name}** to **${targetUser.tag}**.`);
      sendModLog(interaction.guild, modLogEmbed({
        action: '➕ Role Added', color: 0x2ECC71,
        target: targetUser.tag, moderator: interaction.user.tag, reason: `Role: ${role.name}`
      }));
    } catch (error) {
      console.error('Error adding role:', error);
      await interaction.editReply("Couldn't add that role. Make sure I have the **Manage Roles** permission and my role is above it.");
    }
    return;
  }

  // /remove-role
  if (interaction.commandName === 'remove-role') {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const role = interaction.options.getRole('role');

    try {
      const member = await interaction.guild.members.fetch(targetUser.id);

      if (role.position >= interaction.guild.members.me.roles.highest.position) {
        await interaction.editReply("I can't remove that role — it's higher than or equal to my own highest role.");
        return;
      }
      if (!member.roles.cache.has(role.id)) {
        await interaction.editReply(`**${targetUser.tag}** doesn't have the **${role.name}** role.`);
        return;
      }

      await member.roles.remove(role);
      await interaction.editReply(`✅ Removed **${role.name}** from **${targetUser.tag}**.`);
      sendModLog(interaction.guild, modLogEmbed({
        action: '➖ Role Removed', color: 0xE67E22,
        target: targetUser.tag, moderator: interaction.user.tag, reason: `Role: ${role.name}`
      }));
    } catch (error) {
      console.error('Error removing role:', error);
      await interaction.editReply("Couldn't remove that role. Make sure I have the **Manage Roles** permission and my role is above it.");
    }
    return;
  }

  // /slowmode
  if (interaction.commandName === 'slowmode') {
    await interaction.deferReply({ ephemeral: true });
    const seconds = interaction.options.getInteger('seconds');
    const channel = interaction.options.getChannel('channel') || interaction.channel;

    try {
      await channel.setRateLimitPerUser(seconds);
      const label = seconds === 0 ? 'disabled' : `set to ${seconds}s`;
      await interaction.editReply(`🐌 Slowmode ${label} in <#${channel.id}>.`);
      sendModLog(interaction.guild, modLogEmbed({
        action: '🐌 Slowmode Changed', color: 0x5DADE2,
        target: `#${channel.name}`, moderator: interaction.user.tag,
        reason: seconds === 0 ? 'Disabled' : `${seconds} seconds`
      }));
    } catch (error) {
      console.error('Error setting slowmode:', error);
      await interaction.editReply("Couldn't set slowmode. Make sure I have the **Manage Channels** permission.");
    }
    return;
  }

  // /lock
  if (interaction.commandName === 'lock') {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.options.getChannel('channel') || interaction.channel;

    try {
      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false });
      await postLockSticky(channel);
      await interaction.editReply(`🔒 Locked <#${channel.id}>.`);
      sendModLog(interaction.guild, modLogEmbed({
        action: '🔒 Channel Locked', color: 0xE74C3C,
        target: `#${channel.name}`, moderator: interaction.user.tag
      }));
    } catch (error) {
      console.error('Error locking channel:', error);
      await interaction.editReply("Couldn't lock that channel. Make sure I have the **Manage Channels** permission.");
    }
    return;
  }

  // /unlock
  if (interaction.commandName === 'unlock') {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.options.getChannel('channel') || interaction.channel;

    try {
      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: null });
      await removeLockSticky(channel);
      await interaction.editReply(`🔓 Unlocked <#${channel.id}>.`);
      sendModLog(interaction.guild, modLogEmbed({
        action: '🔓 Channel Unlocked', color: 0x2ECC71,
        target: `#${channel.name}`, moderator: interaction.user.tag
      }));
    } catch (error) {
      console.error('Error unlocking channel:', error);
      await interaction.editReply("Couldn't unlock that channel. Make sure I have the **Manage Channels** permission.");
    }
    return;
  }

  // /userinfo
  if (interaction.commandName === 'userinfo') {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user') || interaction.user;

    try {
      const member = await interaction.guild.members.fetch(targetUser.id);
      const roles = member.roles.cache
        .filter(r => r.id !== interaction.guild.id)
        .sort((a, b) => b.position - a.position)
        .map(r => r.name);
      const warnCount = warnCounts.get(`${interaction.guild.id}-${targetUser.id}`) || 0;

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`User Info — ${targetUser.tag}`)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
          { name: 'Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`, inline: false },
          { name: 'Account Created', value: `<t:${Math.floor(targetUser.createdTimestamp / 1000)}:F>`, inline: false },
          { name: 'Warns', value: `${warnCount}/${getWarnLimit(interaction.guild.id)}`, inline: true },
          { name: `Roles (${roles.length})`, value: roles.length > 0 ? roles.join(', ') : 'None', inline: false }
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('Error fetching userinfo:', error);
      await interaction.editReply("Couldn't fetch that member's info.");
    }
    return;
  }

  // /help
  if (interaction.commandName === 'help') {
    await interaction.deferReply({ ephemeral: true });
    const embed = buildHelpEmbed();

    if (!botConfig[interaction.guild.id]) botConfig[interaction.guild.id] = {};
    const stored = botConfig[interaction.guild.id].helpMessage;

    try {
      if (stored) {
        const channel = await client.channels.fetch(stored.channelId).catch(() => null);
        const message = channel ? await channel.messages.fetch(stored.messageId).catch(() => null) : null;

        if (message) {
          await message.edit({ embeds: [embed] });
          await interaction.editReply(`✅ Updated the existing help message in <#${stored.channelId}>.`);
          return;
        }
      }

      // No valid existing message — post a new one here and remember it
      const sent = await interaction.channel.send({ embeds: [embed] });
      botConfig[interaction.guild.id].helpMessage = { channelId: interaction.channel.id, messageId: sent.id };
      saveConfig(botConfig);
      await interaction.editReply(`✅ Posted the help message in <#${interaction.channel.id}>. It'll auto-update every time the bot redeploys.`);
    } catch (error) {
      console.error('Error posting/updating help message:', error);
      await interaction.editReply("Couldn't post or update the help message.");
    }
    return;
  }

  // /poll
  if (interaction.commandName === 'poll') {
    await interaction.deferReply();
    const question = interaction.options.getString('question');
    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

    const options = [1, 2, 3, 4]
      .map(i => ({
        label: interaction.options.getString(`option${i}`),
        emojiInput: interaction.options.getString(`emoji${i}`),
        fallbackEmoji: numberEmojis[i - 1]
      }))
      .filter(o => o.label)
      .map(o => ({ label: o.label, emoji: o.emojiInput || o.fallbackEmoji, voters: new Set() }));

    const token = interaction.id;

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`📊 ${question}`)
      .setDescription(buildPollDescription(options))
      .setFooter({ text: `Poll started by ${interaction.user.tag}` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      options.map((opt, i) => {
        const button = new ButtonBuilder()
          .setCustomId(`pollvote:${token}:${i}`)
          .setLabel(opt.label)
          .setStyle(ButtonStyle.Primary);
        try {
          button.setEmoji(opt.emoji);
        } catch (error) {
          button.setEmoji(numberEmojis[i]);
        }
        return button;
      })
    );

    try {
      const sentMessage = await interaction.editReply({ embeds: [embed], components: [row] });
      const poll = {
        question,
        options,
        authorTag: interaction.user.tag,
        authorId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        messageId: sentMessage.id,
        closed: false
      };
      pollState.set(token, poll);
      persistPoll(token, poll);
    } catch (error) {
      console.error('Error posting poll:', error);
    }
    return;
  }

  // /end-poll
  if (interaction.commandName === 'end-poll') {
    await interaction.deferReply({ ephemeral: true });
    const messageId = interaction.options.getString('poll').trim();

    const entry = [...pollState.entries()].find(([, p]) =>
      p.messageId === messageId && (!p.guildId || p.guildId === interaction.guildId)
    );
    if (!entry) {
      await interaction.editReply("Couldn't find that poll — it may have already been ended, or the bot may have restarted since the list last refreshed. Try the command again and re-pick from the list.");
      return;
    }
    const [token, poll] = entry;

    const isAuthor = interaction.user.id === poll.authorId;
    const isMod = interaction.member.permissions.has(PermissionFlagsBits.ManageMessages);
    if (!isAuthor && !isMod) {
      await interaction.editReply("You can only end polls you created, unless you have the **Manage Messages** permission.");
      return;
    }

    if (poll.closed) {
      await interaction.editReply('That poll is already closed.');
      return;
    }

    poll.closed = true;
    persistPoll(token, poll);

    const embed = new EmbedBuilder()
      .setColor(0x99AAB5)
      .setTitle(`📊 🔒 ${poll.question}`)
      .setDescription(buildPollDescription(poll.options, true))
      .setFooter({ text: `Final results • Poll started by ${poll.authorTag}` })
      .setTimestamp();

    const fallbackEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
    const disabledRow = new ActionRowBuilder().addComponents(
      poll.options.map((opt, i) => {
        const button = new ButtonBuilder()
          .setCustomId(`pollvote:${token}:${i}`)
          .setLabel(opt.label)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true);
        try {
          button.setEmoji(opt.emoji);
        } catch (error) {
          button.setEmoji(fallbackEmojis[i]);
        }
        return button;
      })
    );

    try {
      const channel = await client.channels.fetch(poll.channelId);
      const message = await channel.messages.fetch(poll.messageId);
      await message.edit({ embeds: [embed], components: [disabledRow] });
      await interaction.editReply('✅ Poll ended. Final results have been posted and voting is now locked.');
      sendModLog(interaction.guild, modLogEmbed({
        action: '📊 Poll Ended', color: 0x99AAB5,
        target: poll.question, moderator: interaction.user.tag
      }));
    } catch (error) {
      console.error('Error ending poll:', error);
      await interaction.editReply('Poll marked as closed, but I couldn\'t update the original message (it may have been deleted).');
    }
    return;
  }

  // /poll-votes
  if (interaction.commandName === 'poll-votes') {
    await interaction.deferReply({ ephemeral: true });
    const messageId = interaction.options.getString('poll').trim();

    const entry = [...pollState.entries()].find(([, p]) =>
      p.messageId === messageId && (!p.guildId || p.guildId === interaction.guildId)
    );
    if (!entry) {
      await interaction.editReply("Couldn't find that poll — try the command again and re-pick from the list.");
      return;
    }
    const [, poll] = entry;

    const fields = poll.options.map(opt => {
      const voters = [...opt.voters];
      const value = voters.length > 0
        ? voters.map(id => `<@${id}>`).join('\n')
        : '*No votes yet*';
      return { name: `${opt.emoji} ${opt.label} (${voters.length})`, value: value.length > 1024 ? value.slice(0, 1000) + '\n…' : value };
    });

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`📊 Vote breakdown — ${poll.question}`)
      .addFields(fields)
      .setFooter({ text: poll.closed ? 'This poll is closed' : 'This poll is still open' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // /giveaway
  if (interaction.commandName === 'giveaway') {
    await interaction.deferReply();
    const prize = interaction.options.getString('prize');
    const durationMs = parseInt(interaction.options.getString('duration'), 10);
    const winners = interaction.options.getInteger('winners') || 1;
    const customEmoji = interaction.options.getString('emoji');
    const endTimestamp = Date.now() + durationMs;

    const embed = new EmbedBuilder()
      .setColor(0xF1C40F)
      .setTitle(`🎉 Giveaway: ${prize}`)
      .setDescription(`React with the button below to enter!\nEnds: <t:${Math.floor(endTimestamp / 1000)}:R>\nWinners: **${winners}**\nEntrants: **0**`)
      .setFooter({ text: `Started by ${interaction.user.tag}` })
      .setTimestamp();

    // Button customId needs the message ID, so send first with a placeholder, then edit
    const placeholderRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('giveawayjoin:pending').setLabel('Enter Giveaway').setStyle(ButtonStyle.Success).setEmoji('🎉')
    );

    try {
      const sent = await interaction.editReply({ embeds: [embed], components: [placeholderRow], fetchReply: true });

      const joinButton = new ButtonBuilder()
        .setCustomId(`giveawayjoin:${sent.id}`)
        .setLabel('Enter Giveaway')
        .setStyle(ButtonStyle.Success);
      try {
        joinButton.setEmoji(customEmoji || '🎉');
      } catch (error) {
        joinButton.setEmoji('🎉');
      }
      const finalRow = new ActionRowBuilder().addComponents(joinButton);
      await sent.edit({ components: [finalRow] });

      if (!botConfig[interaction.guild.id]) botConfig[interaction.guild.id] = {};
      if (!botConfig[interaction.guild.id].activeGiveaways) botConfig[interaction.guild.id].activeGiveaways = [];

      const giveaway = {
        messageId: sent.id,
        channelId: interaction.channel.id,
        prize,
        winners,
        endTimestamp,
        entrants: []
      };
      botConfig[interaction.guild.id].activeGiveaways.push(giveaway);
      saveConfig(botConfig);

      setTimeout(() => concludeGiveaway(interaction.guild.id, giveaway), durationMs);
    } catch (error) {
      console.error('Error starting giveaway:', error);
    }
    return;
  }

  // /end-giveaway
  if (interaction.commandName === 'end-giveaway') {
    await interaction.deferReply({ ephemeral: true });
    const messageId = interaction.options.getString('giveaway').trim();

    const guildConfig = botConfig[interaction.guild.id];
    const giveaway = guildConfig?.activeGiveaways?.find(g => g.messageId === messageId);

    if (!giveaway) {
      await interaction.editReply("Couldn't find that giveaway — it may have already ended. Try the command again and re-pick from the list.");
      return;
    }

    await concludeGiveaway(interaction.guild.id, giveaway);
    await interaction.editReply(`✅ Ended the giveaway for **${giveaway.prize}** early and posted the winner(s).`);
    sendModLog(interaction.guild, modLogEmbed({
      action: '🎉 Giveaway Ended Early', color: 0x99AAB5,
      target: giveaway.prize, moderator: interaction.user.tag
    }));
    return;
  }

  // /reroll-giveaway
  if (interaction.commandName === 'reroll-giveaway') {
    await interaction.deferReply({ ephemeral: true });
    const messageId = interaction.options.getString('giveaway').trim();
    const requestedWinners = interaction.options.getInteger('winners');

    const guildConfig = botConfig[interaction.guild.id];
    const record = guildConfig?.endedGiveaways?.find(g => g.messageId === messageId);

    if (!record) {
      await interaction.editReply("Couldn't find that giveaway in recent history — try the command again and re-pick from the list.");
      return;
    }

    const entrants = record.entrants || [];
    if (entrants.length === 0) {
      await interaction.editReply("That giveaway had no entrants, so there's no one to reroll from.");
      return;
    }

    const winnerCount = Math.min(requestedWinners || record.winners || 1, entrants.length);
    const shuffled = [...entrants].sort(() => 0.5 - Math.random());
    const newWinners = shuffled.slice(0, winnerCount);
    const winnersText = newWinners.map(id => `<@${id}>`).join(', ');

    record.lastWinners = newWinners;
    saveConfig(botConfig);

    try {
      const channel = await client.channels.fetch(record.channelId);
      await channel.send(`🔁 **Giveaway Reroll** for **${record.prize}**!\nNew winner(s): ${winnersText}`);
      await interaction.editReply(`✅ Rerolled and announced new winner(s) in <#${record.channelId}>.`);
      sendModLog(interaction.guild, modLogEmbed({
        action: '🔁 Giveaway Rerolled', color: 0x99AAB5,
        target: record.prize, moderator: interaction.user.tag,
        reason: `New winner(s): ${winnersText}`
      }));
    } catch (error) {
      console.error('Error announcing giveaway reroll:', error);
      await interaction.editReply("Couldn't post the reroll announcement — check that I still have access to that channel.");
    }
    return;
  }

  // /remind
  if (interaction.commandName === 'remind') {
    await interaction.deferReply({ ephemeral: true });
    const durationMs = parseInt(interaction.options.getString('duration'), 10);
    const reminderMessage = interaction.options.getString('message');
    const fireTimestamp = Date.now() + durationMs;

    const reminder = { id: interaction.id, userId: interaction.user.id, message: reminderMessage, fireTimestamp };
    if (!botConfig.reminders) botConfig.reminders = [];
    botConfig.reminders.push(reminder);
    saveConfig(botConfig);

    await interaction.editReply(`⏰ Got it — I'll DM you in ${formatDuration(durationMs)}.`);
    scheduleReminder(reminder);
    return;
  }

  // /serverinfo
  if (interaction.commandName === 'serverinfo') {
    await interaction.deferReply();
    const guild = interaction.guild;

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(guild.name)
      .setThumbnail(guild.iconURL())
      .addFields(
        { name: 'Members', value: `${guild.memberCount}`, inline: true },
        { name: 'Boost Level', value: `${guild.premiumTier}`, inline: true },
        { name: 'Boosts', value: `${guild.premiumSubscriptionCount || 0}`, inline: true },
        { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`, inline: false },
        { name: 'Owner', value: `<@${guild.ownerId}>`, inline: false }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // /avatar
  if (interaction.commandName === 'avatar') {
    await interaction.deferReply();
    const targetUser = interaction.options.getUser('user') || interaction.user;

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`${targetUser.tag}'s Avatar`)
      .setImage(targetUser.displayAvatarURL({ size: 1024 }))
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // /suggest
  if (interaction.commandName === 'suggest') {
    await interaction.deferReply({ ephemeral: true });
    const suggestion = interaction.options.getString('suggestion');
    const suggestionsChannelId = botConfig[interaction.guild.id]?.suggestionsChannelId;

    if (!suggestionsChannelId) {
      await interaction.editReply("No suggestions channel has been set yet. Ask a server admin to run **/set-suggestions-channel** first.");
      return;
    }

    try {
      const channel = await client.channels.fetch(suggestionsChannelId);
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setDescription(suggestion)
        .setFooter({ text: `Suggested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
        .setTimestamp();

      const sent = await channel.send({ embeds: [embed] });
      await sent.react('👍');
      await sent.react('👎');

      await interaction.editReply(`✅ Suggestion posted in <#${suggestionsChannelId}>.`);
    } catch (error) {
      console.error('Error posting suggestion:', error);
      await interaction.editReply("Couldn't post that suggestion. Make sure I have permission to send messages in the suggestions channel.");
    }
    return;
  }

  // /set-suggestions-channel
  if (interaction.commandName === 'set-suggestions-channel') {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.options.getChannel('channel');

    if (!botConfig[interaction.guild.id]) botConfig[interaction.guild.id] = {};
    botConfig[interaction.guild.id].suggestionsChannelId = channel.id;
    saveConfig(botConfig);

    await interaction.editReply(`✅ Suggestions will now be posted in <#${channel.id}>.`);
    return;
  }

  // /autorole
  if (interaction.commandName === 'autorole') {
    await interaction.deferReply({ ephemeral: true });
    const enabled = interaction.options.getBoolean('enabled');
    const role = interaction.options.getRole('role');

    if (!botConfig[interaction.guild.id]) botConfig[interaction.guild.id] = {};
    const guildConfig = botConfig[interaction.guild.id];

    if (enabled) {
      const roleId = role ? role.id : guildConfig.autoRole?.roleId;
      if (!roleId) {
        await interaction.editReply("Specify a **role** the first time you enable auto-role.");
        return;
      }
      guildConfig.autoRole = { enabled: true, roleId };
      saveConfig(botConfig);
      await interaction.editReply(`✅ Auto-role turned **on**. New members will get <@&${roleId}>.`);
    } else {
      if (guildConfig.autoRole) guildConfig.autoRole.enabled = false;
      saveConfig(botConfig);
      await interaction.editReply('✅ Auto-role turned **off**.');
    }
    return;
  }

  // /mc-status
  if (interaction.commandName === 'mc-status') {
    await interaction.deferReply();
    const address = interaction.options.getString('address');
    const edition = interaction.options.getString('edition') || 'java';

    try {
      const data = await fetchMinecraftStatus(address, edition);
      const embed = buildMcStatusEmbed(address, data);
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('Error fetching Minecraft status:', error);
      await interaction.editReply("Couldn't reach that server's status API. Double check the address and try again.");
    }
    return;
  }

  // /mc-watch
  if (interaction.commandName === 'mc-watch') {
    await interaction.deferReply({ ephemeral: true });
    const address = interaction.options.getString('address');
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const intervalMinutes = interaction.options.getInteger('interval-minutes') || 5;
    const edition = interaction.options.getString('edition') || 'java';

    try {
      const data = await fetchMinecraftStatus(address, edition);
      const embed = buildMcStatusEmbed(address, data);
      const sent = await channel.send({ embeds: [embed] });

      if (!botConfig[interaction.guild.id]) botConfig[interaction.guild.id] = {};
      botConfig[interaction.guild.id].mcWatch = {
        address, edition, intervalMinutes,
        channelId: channel.id, messageId: sent.id
      };
      saveConfig(botConfig);

      startMcWatchInterval(interaction.guild.id);

      await interaction.editReply(`✅ Now watching **${address}** in <#${channel.id}>, refreshing every ${intervalMinutes} minute(s).`);
    } catch (error) {
      console.error('Error starting mc-watch:', error);
      await interaction.editReply("Couldn't reach that server's status API. Double check the address and try again.");
    }
    return;
  }

  // /mc-unwatch
  if (interaction.commandName === 'mc-unwatch') {
    await interaction.deferReply({ ephemeral: true });
    const guildConfig = botConfig[interaction.guild.id];

    if (!guildConfig?.mcWatch) {
      await interaction.editReply("There's no active Minecraft status watch to stop.");
      return;
    }

    const existingInterval = mcWatchIntervals.get(interaction.guild.id);
    if (existingInterval) clearInterval(existingInterval);
    mcWatchIntervals.delete(interaction.guild.id);

    delete guildConfig.mcWatch;
    saveConfig(botConfig);

    await interaction.editReply('✅ Stopped the live Minecraft status updates.');
    return;
  }

  // /kick
  if (interaction.commandName === 'kick') {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    try {
      const member = await interaction.guild.members.fetch(targetUser.id);

      if (!member.kickable) {
        await interaction.editReply("I can't kick that member — they may have a higher role than me.");
        return;
      }

      await member.kick(reason);
      await interaction.editReply(`👢 Kicked **${targetUser.tag}**. Reason: ${reason}`);
      sendModLog(interaction.guild, modLogEmbed({
        action: '👢 Member Kicked', color: 0xE67E22,
        target: targetUser.tag, moderator: interaction.user.tag, reason
      }));
    } catch (error) {
      console.error('Error kicking member:', error);
      await interaction.editReply("Couldn't kick that member. Make sure I have the **Kick Members** permission.");
    }
    return;
  }

  // /ban
  if (interaction.commandName === 'ban') {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    try {
      const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

      if (member && !member.bannable) {
        await interaction.editReply("I can't ban that member — they may have a higher role than me.");
        return;
      }

      await interaction.guild.members.ban(targetUser.id, { reason });
      await interaction.editReply(`🔨 Banned **${targetUser.tag}**. Reason: ${reason}`);
      sendModLog(interaction.guild, modLogEmbed({
        action: '🔨 Member Banned', color: 0xE74C3C,
        target: targetUser.tag, moderator: interaction.user.tag, reason
      }));
    } catch (error) {
      console.error('Error banning member:', error);
      await interaction.editReply("Couldn't ban that member. Make sure I have the **Ban Members** permission.");
    }
    return;
  }

  // /unban
  if (interaction.commandName === 'unban') {
    await interaction.deferReply({ ephemeral: true });
    const userId = interaction.options.getString('user-id').trim();

    try {
      await interaction.guild.members.unban(userId);
      await interaction.editReply(`✅ Unbanned user with ID **${userId}**.`);
      sendModLog(interaction.guild, modLogEmbed({
        action: '✅ Member Unbanned', color: 0x2ECC71,
        target: userId, moderator: interaction.user.tag
      }));
    } catch (error) {
      console.error('Error unbanning user:', error);
      await interaction.editReply("Couldn't unban that user. Double check the ID and that they're actually banned.");
    }
    return;
  }

  // /timeout
  if (interaction.commandName === 'timeout') {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const durationMs = parseInt(interaction.options.getString('duration'), 10);
    const reason = interaction.options.getString('reason') || 'No reason provided';

    try {
      const member = await interaction.guild.members.fetch(targetUser.id);

      if (!member.moderatable) {
        await interaction.editReply("I can't timeout that member — they may have a higher role than me.");
        return;
      }

      await member.timeout(durationMs, reason);
      const durationLabel = formatDuration(durationMs);
      await interaction.editReply(`🔇 Timed out **${targetUser.tag}** for ${durationLabel}. Reason: ${reason}`);
      sendModLog(interaction.guild, modLogEmbed({
        action: '🔇 Member Timed Out', color: 0xF1C40F,
        target: targetUser.tag, moderator: interaction.user.tag, reason: `${reason} (Duration: ${durationLabel})`
      }));
    } catch (error) {
      console.error('Error timing out member:', error);
      await interaction.editReply("Couldn't timeout that member. Make sure I have the **Moderate Members** permission.");
    }
    return;
  }

  // /warn
  if (interaction.commandName === 'warn') {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    const key = `${interaction.guild.id}-${targetUser.id}`;
    const warnLimit = getWarnLimit(interaction.guild.id);
    const timeoutMs = getWarnTimeoutMs(interaction.guild.id);

    const currentCount = (warnCounts.get(key) || 0) + 1;
    warnCounts.set(key, currentCount);
    saveWarns(warnCounts);

    let resultMessage = `⚠️ Warned **${targetUser.tag}** (${currentCount}/${warnLimit}). Reason: ${reason}`;

    if (currentCount >= warnLimit) {
      try {
        const member = await interaction.guild.members.fetch(targetUser.id);
        if (member.moderatable) {
          await member.timeout(timeoutMs, `Reached ${warnLimit} warns`);
          resultMessage += `\n🔇 This member reached ${warnLimit} warns and has been automatically timed out for ${formatDuration(timeoutMs)}.`;
        } else {
          resultMessage += `\n⚠️ This member reached ${warnLimit} warns, but I couldn't time them out (higher role than me).`;
        }
      } catch (error) {
        console.error('Error auto-timing out warned member:', error);
        resultMessage += `\n⚠️ This member reached ${warnLimit} warns, but the automatic timeout failed.`;
      }
      warnCounts.set(key, 0);
      saveWarns(warnCounts);
    }

    await interaction.editReply(resultMessage);
    sendModLog(interaction.guild, modLogEmbed({
      action: '⚠️ Member Warned', color: 0xF39C12,
      target: targetUser.tag, moderator: interaction.user.tag,
      reason: `${reason} (Warn ${currentCount}/${warnLimit})`
    }));
    return;
  }

  // /warn-config
  if (interaction.commandName === 'warn-config') {
    await interaction.deferReply({ ephemeral: true });
    const limit = interaction.options.getInteger('limit');
    const timeoutDurationStr = interaction.options.getString('timeout-duration');

    if (!botConfig[interaction.guild.id]) botConfig[interaction.guild.id] = {};
    const guildConfig = botConfig[interaction.guild.id];
    if (!guildConfig.warnConfig) guildConfig.warnConfig = {};

    if (limit === null && timeoutDurationStr === null) {
      const currentLimit = getWarnLimit(interaction.guild.id);
      const currentTimeout = getWarnTimeoutMs(interaction.guild.id);
      await interaction.editReply(
        `**Current warn settings:**\n` +
        `• Warn limit: **${currentLimit}**\n` +
        `• Auto-timeout duration: **${formatDuration(currentTimeout)}**\n\n` +
        `Use \`/warn-config limit:<number> timeout-duration:<choice>\` to change either.`
      );
      return;
    }

    if (limit !== null) guildConfig.warnConfig.limit = limit;
    if (timeoutDurationStr !== null) guildConfig.warnConfig.timeoutMs = parseInt(timeoutDurationStr, 10);
    saveConfig(botConfig);

    await interaction.editReply(
      `✅ Warn settings updated.\n` +
      `• Warn limit: **${getWarnLimit(interaction.guild.id)}**\n` +
      `• Auto-timeout duration: **${formatDuration(getWarnTimeoutMs(interaction.guild.id))}**`
    );
    sendModLog(interaction.guild, modLogEmbed({
      action: '⚙️ Warn Config Updated', color: 0x5865F2,
      target: `Limit: ${getWarnLimit(interaction.guild.id)}`, moderator: interaction.user.tag,
      reason: `Auto-timeout: ${formatDuration(getWarnTimeoutMs(interaction.guild.id))}`
    }));
    return;
  }

  // /warnings
  if (interaction.commandName === 'warnings') {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const key = `${interaction.guild.id}-${targetUser.id}`;
    const count = warnCounts.get(key) || 0;

    await interaction.editReply(`**${targetUser.tag}** currently has **${count}/${getWarnLimit(interaction.guild.id)}** warns.`);
    return;
  }

  // /set-modlog
  if (interaction.commandName === 'set-modlog') {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.options.getChannel('channel');

    if (!botConfig[interaction.guild.id]) botConfig[interaction.guild.id] = {};
    botConfig[interaction.guild.id].modLogChannelId = channel.id;
    saveConfig(botConfig);

    await interaction.editReply(`✅ Mod-log channel set to <#${channel.id}>. All future moderation actions will be logged there.`);
    return;
  }

  // /remove-warn
  if (interaction.commandName === 'remove-warn') {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const key = `${interaction.guild.id}-${targetUser.id}`;

    const currentCount = warnCounts.get(key) || 0;
    const newCount = Math.max(0, currentCount - 1);
    warnCounts.set(key, newCount);
    saveWarns(warnCounts);

    await interaction.editReply(`✅ Removed a warn from **${targetUser.tag}**. Now at **${newCount}/${getWarnLimit(interaction.guild.id)}**.`);
    sendModLog(interaction.guild, modLogEmbed({
      action: '➖ Warn Removed', color: 0x2ECC71,
      target: targetUser.tag, moderator: interaction.user.tag,
      reason: `Now at ${newCount}/${getWarnLimit(interaction.guild.id)}`
    }));
    return;
  }

  // /clear-warnings
  if (interaction.commandName === 'clear-warnings') {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const key = `${interaction.guild.id}-${targetUser.id}`;

    warnCounts.set(key, 0);
    saveWarns(warnCounts);

    await interaction.editReply(`✅ Cleared all warns for **${targetUser.tag}**.`);
    sendModLog(interaction.guild, modLogEmbed({
      action: '🧹 Warns Cleared', color: 0x2ECC71,
      target: targetUser.tag, moderator: interaction.user.tag
    }));
    return;
  }

  // /untimeout
  if (interaction.commandName === 'untimeout') {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user');

    try {
      const member = await interaction.guild.members.fetch(targetUser.id);

      if (!member.communicationDisabledUntil) {
        await interaction.editReply(`**${targetUser.tag}** doesn't currently have an active timeout.`);
        return;
      }

      await member.timeout(null);
      await interaction.editReply(`✅ Removed timeout from **${targetUser.tag}**.`);
      sendModLog(interaction.guild, modLogEmbed({
        action: '🔊 Timeout Removed', color: 0x2ECC71,
        target: targetUser.tag, moderator: interaction.user.tag
      }));
    } catch (error) {
      console.error('Error removing timeout:', error);
      await interaction.editReply("Couldn't remove that member's timeout. Make sure I have the **Moderate Members** permission.");
    }
    return;
  }

  // /purge
  if (interaction.commandName === 'purge') {
    const amount = interaction.options.getInteger('amount');
    const all = interaction.options.getBoolean('all') || false;

    if (!all && !amount) {
      await interaction.reply({ content: 'Specify an **amount**, or set **all** to true.', ephemeral: true });
      return;
    }

    const label = all ? 'ALL messages' : `${amount} message(s)`;

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('purge_confirm').setLabel('Confirm Purge').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('purge_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );

    const confirmMsg = await interaction.reply({
      content: `⚠️ Are you sure you want to delete **${label}** from this channel? This cannot be undone.`,
      components: [confirmRow],
      ephemeral: true,
      fetchReply: true
    });

    let buttonInteraction;
    try {
      buttonInteraction = await confirmMsg.awaitMessageComponent({
        filter: i => i.user.id === interaction.user.id,
        time: 15000
      });
    } catch {
      await interaction.editReply({ content: 'Purge cancelled (confirmation timed out).', components: [] });
      return;
    }

    if (buttonInteraction.customId === 'purge_cancel') {
      await buttonInteraction.update({ content: 'Purge cancelled.', components: [] });
      return;
    }

    await buttonInteraction.update({ content: `🧹 Deleting ${label}... this may take a moment.`, components: [] });

    let deletedTotal = 0;
    const transcriptLines = [];

    function recordBatch(fetched) {
      // Newest messages come first from fetch(); reverse so the transcript reads oldest -> newest
      const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const msg of sorted) {
        const author = msg.author ? msg.author.tag : 'Unknown user';
        const time = new Date(msg.createdTimestamp).toISOString();
        const content = msg.content && msg.content.length > 0 ? msg.content : '[no text content — embed, attachment, or system message]';
        transcriptLines.push(`[${time}] ${author}: ${content}`);
      }
    }

    try {
      if (all) {
        let keepGoing = true;
        while (keepGoing) {
          const fetched = await interaction.channel.messages.fetch({ limit: 100 });
          if (fetched.size === 0) break;
          recordBatch(fetched);
          const deleted = await interaction.channel.bulkDelete(fetched, true);
          deletedTotal += deleted.size;
          if (deleted.size < fetched.size) keepGoing = false; // hit messages older than 14 days
        }
      } else {
        let remaining = amount;
        while (remaining > 0) {
          const batchSize = Math.min(remaining, 100);
          const fetched = await interaction.channel.messages.fetch({ limit: batchSize });
          if (fetched.size === 0) break;
          recordBatch(fetched);
          const deleted = await interaction.channel.bulkDelete(fetched, true);
          deletedTotal += deleted.size;
          remaining -= batchSize;
          if (deleted.size < fetched.size) break; // hit messages older than 14 days
        }
      }

      await interaction.editReply({ content: `✅ Deleted ${deletedTotal} message(s).`, components: [] });

      const transcriptText = transcriptLines.length > 0
        ? transcriptLines.join('\n')
        : '(No message content captured.)';
      const transcriptFile = new AttachmentBuilder(
        Buffer.from(transcriptText, 'utf8'),
        { name: `purge-log-${Date.now()}.txt` }
      );

      sendModLog(interaction.guild, modLogEmbed({
        action: '🧹 Channel Purged', color: 0x95A5A6,
        target: `#${interaction.channel.name}`, moderator: interaction.user.tag,
        reason: `${deletedTotal} message(s) deleted${all ? ' (all)' : ''} — see attached transcript`
      }), { files: [transcriptFile] });
    } catch (error) {
      console.error('Error purging messages:', error);
      await interaction.editReply({
        content: `Deleted ${deletedTotal} message(s) before running into an error. Note: Discord only allows bulk-deleting messages younger than 14 days.`,
        components: []
      });
    }
    return;
  }

  // /ticket-setup
  if (interaction.commandName === 'ticket-setup') {
    await interaction.deferReply({ ephemeral: true });
    const category = interaction.options.getChannel('category');
    const supportRole = interaction.options.getRole('support-role');
    const logChannel = interaction.options.getChannel('log-channel');

    if (!botConfig[interaction.guild.id]) botConfig[interaction.guild.id] = {};
    const guildConfig = botConfig[interaction.guild.id];

    guildConfig.tickets = {
      ...(guildConfig.tickets || {}),
      categoryId: category.id,
      supportRoleId: supportRole.id,
      logChannelId: logChannel ? logChannel.id : (guildConfig.tickets?.logChannelId || null),
      counter: guildConfig.tickets?.counter || 0,
      openByUser: guildConfig.tickets?.openByUser || {},
      data: guildConfig.tickets?.data || {}
    };
    saveConfig(botConfig);

    await interaction.editReply(
      `✅ Ticket system configured.\n` +
      `• Category: **${category.name}**\n` +
      `• Support role: <@&${supportRole.id}>\n` +
      `• Log channel: ${logChannel ? `<#${logChannel.id}>` : 'mod-log (if set) or none'}\n\n` +
      `Run \`/ticket-panel\` in a channel to post the "Open a Ticket" button.`
    );
    return;
  }

  // /ticket-panel
  if (interaction.commandName === 'ticket-panel') {
    await interaction.deferReply({ ephemeral: true });
    const ticketConfig = getTicketConfig(interaction.guild.id);

    if (!ticketConfig || !ticketConfig.categoryId || !ticketConfig.supportRoleId) {
      await interaction.editReply("Ticket system isn't set up yet. Run `/ticket-setup` first.");
      return;
    }

    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');

    try {
      const sent = await channel.send({
        embeds: [ticketPanelEmbed(title, description)],
        components: [ticketPanelRow()]
      });

      ticketConfig.panel = { channelId: channel.id, messageId: sent.id };
      saveConfig(botConfig);

      await interaction.editReply(`✅ Ticket panel posted in <#${channel.id}>.`);
    } catch (error) {
      console.error('Error posting ticket panel:', error);
      await interaction.editReply("Couldn't post the ticket panel there. Make sure I can send messages in that channel.");
    }
    return;
  }
});

// Keeps the "channel is locked" message pinned to the bottom of any channel that has one active
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;

  const guildConfig = botConfig[message.guild.id];
  const stickyId = guildConfig?.stickyMessages?.[message.channel.id];
  if (!stickyId) return;

  try {
    const oldSticky = await message.channel.messages.fetch(stickyId).catch(() => null);
    if (oldSticky) await oldSticky.delete().catch(() => {});

    const newSticky = await message.channel.send({ embeds: [lockStickyEmbed()] });
    guildConfig.stickyMessages[message.channel.id] = newSticky.id;
    saveConfig(botConfig);
  } catch (error) {
    console.error('Error reposting lock sticky message:', error);
  }
});

// Auto-assigns a role to new members, if enabled for this server
client.on('guildMemberAdd', async member => {
  const autoRole = botConfig[member.guild.id]?.autoRole;
  if (!autoRole || !autoRole.enabled || !autoRole.roleId) return;

  try {
    await member.roles.add(autoRole.roleId);
  } catch (error) {
    console.error(`Error auto-assigning role in guild ${member.guild.id}:`, error);
  }
});

client.login(TOKEN);
