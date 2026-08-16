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
  EmbedBuilder
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
    return;
  }

  // /clear
  if (interaction.commandName === 'clear') {
    await interaction.deferReply({ ephemeral: true });
    const amount = interaction.options.getInteger('amount');

    try {
      const deleted = await interaction.channel.bulkDelete(amount, true);
      await interaction.editReply(`🧹 Deleted ${deleted.size} message(s).`);
    } catch (error) {
      console.error('Error clearing messages:', error);
      await interaction.editReply("Couldn't delete those messages. Note: Discord only allows bulk-deleting messages younger than 14 days.");
    }
    return;
  }
});

client.login(TOKEN);
