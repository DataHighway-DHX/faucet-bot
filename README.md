### Faucet Bot For Acala

### Environment Required
1. nodejs
2. redis
3. pm2

### Start with pm2
```bash
cd $PROJECT_ROOT

yarn

pm2 start -- environment.json
```

--------------------
### Discord setup

1. Create discord bot - https://discord.com/developers/applications/796385212472229920/bot
2. Enter token in config.toml, section `[channel.discord]`
3. Go to OAuth2 section, check 'Bot' scope, check 'Send messages' permission
4. Take OAuth2 url, open it. Pick a server, invite the bot.
5. By default, 'faucet' text channel is used, you can change it in config.toml

**! Remove Matrix section if you don't use Matrix.**