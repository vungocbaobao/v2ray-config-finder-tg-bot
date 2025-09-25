# V2Ray Config Finder & Tester Bot

**Live example**: https://t.me/v2raypooliran

A powerful two-part Node.js system for automatically fetching, testing, and posting high-quality V2Ray configs to a Telegram channel. It consists of an independent Tester that runs in the background and a lightweight Telegram Bot that posts the verified results.

It automatically finds working configs, measures their real latency, and saves them. The bot then posts them one by one, ensuring your channel always has a steady stream of working proxies.

✨ **Features**

**Two-Part System**: A robust Tester runs independently from the lightweight Telegram Bot for maximum reliability and separation of concerns.

🔎 **Fetch From Public Sources**: The Tester fetches configs from any number of public URLs you provide.

⚡ **Real-World Latency Testing**: Performs a true connection test (similar to "Real Delay" in clients) to measure latency in milliseconds and discard dead links.

🛠 **Multi-Protocol Support**: Natively parses and tests multiple protocols:

    VLESS
    VMess
    Trojan
    Shadowsocks (SS)
    Hysteria2

🗄 **Persistent Storage**: Uses an SQLite database to store the list of source URLs.

🤖 **Full Admin Control via Telegram**: The bot allows an admin to manage the tester's source list and the poster's schedule directly from Telegram.

📂 **Organized Results**: The Tester saves batches of working, sorted configs into timestamped .json files in a results/ directory.

## 🚀 Getting Started

1. Install Dependencies: `npm install`

2. Download xray core:
You will also need the Xray-core executable in the root directory. Download it from the official releases page and place the xray file in your project folder.

3. Environment Setup:
Create a `.env` file like `.env.example` in the root directory and fill it with your details:

4. Run the System:
You need to run two processes in two separate terminals.

      Terminal 1 - **Start the Tester**:
      `npm run start:tester`
      The tester will immediately begin its first cycle of fetching and testing configs. It will run automatically every 30 minutes (configurable in .env).

      Terminal 2 - **Start the Telegram Bot**:
      `npm run start:bot`
      The bot will start and listen for your commands. Once the tester produces a result file, the bot will begin posting from it on its own schedule.

5. Configure the Bot:
Talk to `@BotFather` on Telegram and set these commands:

      `/addfile <URL>`: Tell the tester to start using a new source URL.

      `/removefile <ID>`: Remove a file URL by id.

      `/listfiles`: See all the source URLs the tester is checking.

      `/setschedule <seconds>`: Set how often the bot should post a new config to the channel.

      `/getschedule`: Shows current schedule value.

      `/help`: helper message

📂 Project Structure
```
.
├── tester.js          # Core logic for fetching & testing configs
├── bot.js             # The Telegram bot for posting and admin control
├── database.js        # SQLite setup and helpers
├── /results/          # Tested & verified configs are saved here (JSON)
├── .env               # Your environment variables
└── package.json       # Project scripts and dependencies
```

🧪 Example Output File (`results/Sub1_2025-09-26T12-00-00.json`)
```json
[
  {
    "config": "vless://uuid@1.2.3.4:443?security=tls type=ws#Working%20Server%201",
    "latency": 240,
    "name": "Working Server 1"
  },
  {
    "config": "ss://Y2hh...@server.com:8080#Fastest%20SS%20Node",
    "latency": 320,
    "name": "Fastest SS Node"
  }
]
```

## 🤝 Contributing

Pull requests are welcome! Feel free to open issues or suggest improvements.
