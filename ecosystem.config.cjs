module.exports = {
  apps: [
    {
      name: "karnevil9",
      script: "packages/cli/dist/index.js",
      args: "server --insecure --planner claude-code --agentic",
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
    {
      name: "dashboard",
      script: "node_modules/.bin/next",
      args: "start -p 3001",
      cwd: "packages/dashboard",
      max_memory_restart: "256M",
      autorestart: true,
      watch: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
