module.exports = {
  apps: [
    {
      name: "karnevil9",
      script: "packages/cli/dist/index.js",
      args: "server --insecure --planner claude-code",
      interpreter: "node",
      max_memory_restart: "512M",
      autorestart: true,
      watch: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        NODE_ENV: "production",
        KARNEVIL9_CORS_ORIGINS: "*",
      },
    },
  ],
};
