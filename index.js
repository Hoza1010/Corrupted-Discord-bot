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

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

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
    await interaction.deferReply();

    const eventName = interaction.options.getString('event-name');
    const stageChannel = interaction.options.getChannel('stage-channel');

    try {
      // Create the stage instance (this opens/starts the Stage)
      await stageChannel.createStageInstance({
        topic: eventName,
        privacyLevel: 2 // GUILD_ONLY
      });

      // Announce it to everyone in the channel the command was run in
      await interaction.channel.send({
        content: `@everyone 📣 **${eventName}** has started in <#${stageChannel.id}>! Join now.`,
        allowedMentions: { parse: ['everyone'] }
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
    await interaction.deferReply();

    const stageChannel = interaction.options.getChannel('stage-channel');

    try {
      const stageInstance = await interaction.guild.stageInstances.fetch(stageChannel.id).catch(() => null);

      if (!stageInstance) {
        await interaction.editReply(`There's no active stage event in <#${stageChannel.id}>.`);
        return;
      }

      const endedTopic = stageInstance.topic;
      await stageInstance.delete();

      await interaction.channel.send(`🔚 The stage event **${endedTopic}** in <#${stageChannel.id}> has ended.`);
      await interaction.editReply(`Stage event ended in <#${stageChannel.id}>.`);
    } catch (error) {
      console.error('Error ending stage:', error);
      await interaction.editReply(
        `Couldn't end the stage. Make sure the bot has **Manage Channels** permission.`
      );
    }
    return;
  }
});

client.login(TOKEN);
