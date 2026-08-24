const axios = require("axios");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

module.exports.config = {
  name: "install",
  version: "3.0.0",
  hasPermssion: 2,
  credits: "rX Abdullah",
  description: "Install/update/delete JS commands and events",
  usePrefix: true,
  commandCategory: "utility",
  usages: "install <file.js> <code/url> | install event <file.js> <code/url> | reply to JS",
  cooldowns: 5
};

const MAX_FILE_SIZE = 5 * 1024 * 1024;

function send(api, msg, threadID, messageID) {
  return new Promise((resolve, reject) => {
    api.sendMessage(msg, threadID, (err, info) => {
      if (err) return reject(err);
      resolve(info);
    }, messageID);
  });
}

function cleanFilename(name, fallback = `cmd_${Date.now()}.js`) {
  if (!name || typeof name !== "string") return fallback;

  let file = path.basename(name.trim());
  file = file.replace(/[^\w.-]/g, "_");

  if (!file.toLowerCase().endsWith(".js")) {
    file += ".js";
  }

  if (file === ".js" || file.includes("..")) {
    return fallback;
  }

  return file;
}

function unloadCommand(name) {
  try {
    if (global.client?.commands) {
      global.client.commands.delete(name);
    }

    if (Array.isArray(global.client?.eventRegistered)) {
      global.client.eventRegistered =
        global.client.eventRegistered.filter(e => e !== name);
    }
  } catch (_) {}
}

function loadCommand(filename) {
  try {
    const filePath = path.join(__dirname, filename);

    delete require.cache[require.resolve(filePath)];

    const goatCompat = require(
      global.client.mainPath + "/utils/goatCompat"
    );

    const command = goatCompat.normalize(
      require(filePath),
      filename
    );

    if (!command?.config?.name) {
      throw new Error("Invalid command structure!");
    }

    if (typeof command.run !== "function") {
      throw new Error("Command must export run!");
    }

    if (command.config.dependencies) {
      for (const dep of Object.keys(command.config.dependencies)) {
        global.nodemodule[dep] = require(dep);
      }
    }

    unloadCommand(command.config.name);

    if (!global.client.commands) {
      global.client.commands = new Map();
    }

    if (
      command.handleEvent &&
      Array.isArray(global.client.eventRegistered) &&
      !global.client.eventRegistered.includes(command.config.name)
    ) {
      global.client.eventRegistered.push(command.config.name);
    }

    global.client.commands.set(
      command.config.name,
      command
    );

    return {
      ok: true,
      name: command.config.name
    };

  } catch (error) {
    return {
      ok: false,
      error
    };
  }
}

function loadEvent(filename) {
  try {
    const eventsDir = path.join(
      global.client.mainPath,
      "modules",
      "events"
    );

    const filePath = path.join(
      eventsDir,
      filename
    );

    delete require.cache[require.resolve(filePath)];

    const evt = require(filePath);

    if (!evt?.config?.name) {
      throw new Error(
        "Invalid event structure: config.name missing"
      );
    }

    if (
      typeof evt.handleEvent !== "function" &&
      typeof evt.run !== "function"
    ) {
      throw new Error(
        "Event must export handleEvent or run!"
      );
    }

    if (!Array.isArray(global.client.eventRegistered)) {
      global.client.eventRegistered = [];
    }

    if (
      !global.client.eventRegistered.includes(
        evt.config.name
      )
    ) {
      global.client.eventRegistered.push(
        evt.config.name
      );
    }

    if (global.client.events?.set) {
      global.client.events.set(
        evt.config.name,
        evt
      );
    }

    if (
      global.client.commands?.set &&
      !global.client.commands.has(evt.config.name)
    ) {
      global.client.commands.set(
        evt.config.name,
        evt
      );
    }

    return {
      ok: true,
      name: evt.config.name
    };

  } catch (error) {
    return {
      ok: false,
      error
    };
  }
}

async function saveAndLoad({
  filename,
  code,
  isEvent,
  api,
  threadID,
  messageID
}) {
  const targetDir = isEvent
    ? path.join(
        global.client.mainPath,
        "modules",
        "events"
      )
    : __dirname;

  fs.mkdirSync(targetDir, {
    recursive: true
  });

  const filePath = path.join(
    targetDir,
    filename
  );

  fs.writeFileSync(
    filePath,
    code,
    "utf8"
  );

  const result = isEvent
    ? loadEvent(filename)
    : loadCommand(filename);

  if (!result.ok) {
    return send(
      api,
      `⚠️ File saved but failed to load.\n\n${result.error?.message || "Unknown error"}`,
      threadID,
      messageID
    );
  }

  return send(
    api,
    `✅ ${isEvent ? "Event" : "Command"} installed + loaded!\n\n📄 File: ${filename}\n📦 Name: ${result.name}`,
    threadID,
    messageID
  );
}

async function getURLCode(url) {
  const response = await axios.get(
    url,
    {
      timeout: 60000,
      responseType: "text",
      maxContentLength: MAX_FILE_SIZE
    }
  );

  if (typeof response.data !== "string") {
    throw new Error(
      "URL did not return JavaScript code"
    );
  }

  return response.data;
}

function findJSAttachment(event) {
  const attachments =
    event.messageReply?.attachments ||
    event.attachments ||
    [];

  if (!Array.isArray(attachments)) {
    return null;
  }

  return attachments.find(att => {
    const filename =
      String(
        att?.filename ||
        att?.name ||
        ""
      );

    const type =
      String(
        att?.type ||
        att?.mimeType ||
        ""
      );

    return (
      /\.js$/i.test(filename) ||
      /javascript/i.test(type)
    );
  });
}

async function downloadAttachment(attachment) {
  const url =
    attachment.url ||
    attachment.downloadUrl ||
    attachment.href;

  if (!url) {
    throw new Error(
      "JS attachment download URL not found"
    );
  }

  const response = await axios.get(
    url,
    {
      responseType: "arraybuffer",
      timeout: 60000,
      maxContentLength: MAX_FILE_SIZE
    }
  );

  return Buffer
    .from(response.data)
    .toString("utf8");
}

module.exports.run = async function ({
  api,
  args,
  event
}) {

  try {

    let isEvent = false;
    let filename = null;
    let source = "";

    /*
      COMMAND:

      install file.js <code/url>

      EVENT:

      install event file.js <code/url>

      ATTACHMENT:

      Reply to .js file:
      install

      EVENT ATTACHMENT:

      Reply to .js file:
      install event
    */

    if (
      args[0] &&
      args[0].toLowerCase() === "event"
    ) {

      isEvent = true;

      filename = args[1];

      source = args
        .slice(2)
        .join(" ")
        .trim();

    } else {

      filename = args[0];

      source = args
        .slice(1)
        .join(" ")
        .trim();

    }

    /*
      Check JS attachment
    */

    const attachment =
      findJSAttachment(event);

    if (!source && attachment) {

      filename =
        filename ||
        attachment.filename ||
        attachment.name ||
        `cmd_${Date.now()}.js`;

      source =
        await downloadAttachment(
          attachment
        );
    }

    /*
      Check replied text
    */

    if (
      !source &&
      event.messageReply?.body
    ) {

      source =
        event.messageReply.body.trim();
    }

    /*
      URL as first argument
    */

    if (
      !source &&
      filename &&
      /^https?:\/\//i.test(filename)
    ) {

      source = filename;

      try {

        filename =
          path.basename(
            new URL(source).pathname
          );

      } catch (_) {}

    }

    if (!source) {

      return send(
        api,

        "⚠️ Install Usage:\n\n" +

        "1️⃣ Command:\n" +
        "install file.js <code/url>\n\n" +

        "2️⃣ Event:\n" +
        "install event file.js <code/url>\n\n" +

        "3️⃣ JS file reply:\n" +
        "Reply to .js file → install\n\n" +

        "4️⃣ Event file reply:\n" +
        "Reply to .js file → install event",

        event.threadID,
        event.messageID
      );
    }

    filename =
      cleanFilename(filename);

    /*
      Prevent unsafe paths
    */

    if (
      filename.includes("..") ||
      path.isAbsolute(filename)
    ) {

      return send(
        api,
        "❌ Invalid filename!",
        event.threadID,
        event.messageID
      );
    }

    let code = source;

    /*
      Download code from URL
    */

    if (
      /^https?:\/\/\S+$/i.test(source)
    ) {

      try {

        code =
          await getURLCode(source);

      } catch (error) {

        return send(
          api,
          `❌ URL থেকে JavaScript আনা যায়নি:\n${error.message}`,
          event.threadID,
          event.messageID
        );
      }
    }

    /*
      Empty code check
    */

    if (
      !code ||
      !code.trim()
    ) {

      return send(
        api,
        "❌ Empty JavaScript file!",
        event.threadID,
        event.messageID
      );
    }

    /*
      Syntax check
    */

    try {

      new vm.Script(
        code,
        {
          filename
        }
      );

    } catch (error) {

      return send(
        api,
        `❌ Syntax Error:\n${error.message}`,
        event.threadID,
        event.messageID
      );
    }

    const targetDir =
      isEvent
        ? path.join(
            global.client.mainPath,
            "modules",
            "events"
          )
        : __dirname;

    const savePath =
      path.join(
        targetDir,
        filename
      );

    /*
      Existing file
    */

    if (
      fs.existsSync(savePath)
    ) {

      const info =
        await send(
          api,

          `⚠️ ${filename} already exists.\n\n` +
          `React with ✅ or 👍 to replace it.`,

          event.threadID,
          event.messageID
        );

      if (
        !global.client.handleReaction
      ) {
        global.client.handleReaction =
          [];
      }

      global.client.handleReaction.push({

        name: "install",

        type: "replace",

        messageID:
          info.messageID,

        author:
          event.senderID,

        filename,

        code,

        isEvent

      });

      return;
    }

    return saveAndLoad({

      filename,

      code,

      isEvent,

      api,

      threadID:
        event.threadID,

      messageID:
        event.messageID

    });

  } catch (error) {

    console.error(
      "[INSTALL ERROR]",
      error
    );

    return send(
      api,

      `❌ Install failed:\n${error.message}`,

      event.threadID,

      event.messageID
    );
  }
};

module.exports.handleReaction =
async function ({
  api,
  event,
  handleReaction
}) {

  if (
    handleReaction.name !==
    "install"
  ) {
    return;
  }

  if (
    event.userID !==
    handleReaction.author
  ) {
    return;
  }

  if (
    event.reaction !== "✅" &&
    event.reaction !== "👍"
  ) {
    return;
  }

  try {
    api.unsendMessage(
      handleReaction.messageID
    );
  } catch (_) {}

  return saveAndLoad({

    filename:
      handleReaction.filename,

    code:
      handleReaction.code,

    isEvent:
      handleReaction.isEvent,

    api,

    threadID:
      event.threadID,

    messageID:
      event.messageID

  });
};
