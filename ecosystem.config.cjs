module.exports = {
  apps: [
    {
      name: "karnevil9",
      script: "packages/cli/dist/index.js",
      args: "server --insecure --planner claude --agentic",
      interpreter: "/opt/homebrew/bin/node",
      node_args: "--unhandled-rejections=throw",
      max_memory_restart: "1G",
      autorestart: true,
      watch: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        NODE_ENV: "production",
        KARNEVIL9_CORS_ORIGINS: "*",
        PATH: "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      },
    },
    {
      name: "dashboard",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3001 -H 0.0.0.0",
      cwd: "packages/dashboard",
      interpreter: "node",
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
