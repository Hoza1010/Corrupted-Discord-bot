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
  AttachmentBuilder
} = require('discord.js');
const fs = require('fs');
const path = require('path');

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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// Tracks warns per user, per server. Persisted to disk so it survives restarts.
// Key: "guildId-userId" -> number of warns
const warnCounts = loadWarns();
const WARN_LIMIT = 3;
const AUTO_TIMEOUT_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

function formatDuration(ms) {
  const map = {
    60000: '60 seconds',
    300000: '5 minutes',
    600000: '10 minutes',
    3600000: '1 hour',
    86400000: '1 day',
    604800000: '1 week'
  };
  return map[ms] || `${ms}ms`;
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
    ),

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
        .addChoices(
          { name: '60 seconds', value: '60000' },
          { name: '5 minutes', value: '300000' },
          { name: '10 minutes', value: '600000' },
          { name: '1 hour', value: '3600000' },
          { name: '1 day', value: '86400000' },
          { name: '1 week', value: '604800000' }
        )
    )
    .addStringOption(option =>
      option.setName('reason').setDescription('Reason for the timeout').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a member (3 warns = automatic 3-day timeout)')
    .addUserOption(option =>
      option.setName('user').setDescription('The member to warn').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('reason').setDescription('Reason for the warning').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Delete a number of recent messages from a channel')
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('How many messages to delete (1-100)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

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
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
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

// When the bot is ready
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}. Bot is online!`);
});

client.on('interactionCreate', async interaction => {
  // Handle the embed modal submission
  if (interaction.isModalSubmit() && interaction.customId.startsWith('embedModal')) {
    const title = interaction.fields.getTextInputValue('embedTitle');
    const description = interaction.fields.getTextInputValue('embedDescription');
    const colorInput = interaction.fields.getTextInputValue('embedColor');
    const channelId = interaction.customId.split(':')[1];

    let color = 0x5865F2; // default Discord blurple
    if (colorInput && /^#?[0-9A-Fa-f]{6}$/.test(colorInput.trim())) {
      color = parseInt(colorInput.trim().replace('#', ''), 16);
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(color)
      .setTimestamp();

    try {
      const targetChannel = channelId ? await client.channels.fetch(channelId) : interaction.channel;
      await targetChannel.send({ embeds: [embed] });
      await interaction.reply({ content: `Embed sent to <#${targetChannel.id}>.`, ephemeral: true });
    } catch (error) {
      console.error('Error sending embed:', error);
      await interaction.reply({ content: "Couldn't send the embed. Check the bot's permissions in that channel.", ephemeral: true });
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // /embed - opens a form with a multi-line description box
  if (interaction.commandName === 'embed') {
    const targetChannel = interaction.options.getChannel('channel');

    const modal = new ModalBuilder()
      .setCustomId(`embedModal:${targetChannel ? targetChannel.id : ''}`)
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

    const currentCount = (warnCounts.get(key) || 0) + 1;
    warnCounts.set(key, currentCount);
    saveWarns(warnCounts);

    let resultMessage = `⚠️ Warned **${targetUser.tag}** (${currentCount}/${WARN_LIMIT}). Reason: ${reason}`;

    if (currentCount >= WARN_LIMIT) {
      try {
        const member = await interaction.guild.members.fetch(targetUser.id);
        if (member.moderatable) {
          await member.timeout(AUTO_TIMEOUT_MS, `Reached ${WARN_LIMIT} warns`);
          resultMessage += `\n🔇 This member reached ${WARN_LIMIT} warns and has been automatically timed out for 3 days.`;
        } else {
          resultMessage += `\n⚠️ This member reached ${WARN_LIMIT} warns, but I couldn't time them out (higher role than me).`;
        }
      } catch (error) {
        console.error('Error auto-timing out warned member:', error);
        resultMessage += `\n⚠️ This member reached ${WARN_LIMIT} warns, but the automatic timeout failed.`;
      }
      warnCounts.set(key, 0);
      saveWarns(warnCounts);
    }

    await interaction.editReply(resultMessage);
    sendModLog(interaction.guild, modLogEmbed({
      action: '⚠️ Member Warned', color: 0xF39C12,
      target: targetUser.tag, moderator: interaction.user.tag,
      reason: `${reason} (Warn ${currentCount}/${WARN_LIMIT})`
    }));
    return;
  }

  // /clear
  if (interaction.commandName === 'clear') {
    await interaction.deferReply({ ephemeral: true });
    const amount = interaction.options.getInteger('amount');

    try {
      const deleted = await interaction.channel.bulkDelete(amount, true);
      await interaction.editReply(`🧹 Deleted ${deleted.size} message(s).`);
      sendModLog(interaction.guild, modLogEmbed({
        action: '🧹 Messages Cleared', color: 0x95A5A6,
        target: `#${interaction.channel.name}`, moderator: interaction.user.tag,
        reason: `${deleted.size} message(s) deleted`
      }));
    } catch (error) {
      console.error('Error clearing messages:', error);
      await interaction.editReply("Couldn't delete those messages. Note: Discord only allows bulk-deleting messages younger than 14 days.");
    }
    return;
  }

  // /warnings
  if (interaction.commandName === 'warnings') {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const key = `${interaction.guild.id}-${targetUser.id}`;
    const count = warnCounts.get(key) || 0;

    await interaction.editReply(`**${targetUser.tag}** currently has **${count}/${WARN_LIMIT}** warns.`);
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

    await interaction.editReply(`✅ Removed a warn from **${targetUser.tag}**. Now at **${newCount}/${WARN_LIMIT}**.`);
    sendModLog(interaction.guild, modLogEmbed({
      action: '➖ Warn Removed', color: 0x2ECC71,
      target: targetUser.tag, moderator: interaction.user.tag,
      reason: `Now at ${newCount}/${WARN_LIMIT}`
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
});

client.login(TOKEN);
