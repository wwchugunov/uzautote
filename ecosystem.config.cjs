module.exports = {
  apps: [
    {
      name: "uzautote",
      cwd: "/home/u8802/uzautote/uzautote",
      script: "/home/u8802/uzautote/uzautote/index.js",
      interpreter: "/root/.nvm/versions/node/v22.15.0/bin/node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
