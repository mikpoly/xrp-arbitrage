const express = require("express");
const path = require("path");
const logger = require("../logger");

function startDashboard({ port, getState }) {
  const app = express();

  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/state", (req, res) => {
    try {
      const state = getState();
      res.json(state);
    } catch (err) {
      logger.error("Dashboard: impossible de construire /api/state", {
        error: err.message,
      });

      res.status(500).json({
        error: err.message,
      });
    }
  });

  app.get("/api/logs", (req, res) => {
    try {
      const state = getState();
      res.json({
        logs: state.logs || [],
      });
    } catch (err) {
      logger.error("Dashboard: impossible de construire /api/logs", {
        error: err.message,
      });

      res.status(500).json({
        error: err.message,
      });
    }
  });

  app.get("/api/watchlist", (req, res) => {
    try {
      const state = getState();
      res.json({
        watchlist: state.watchlist || [],
      });
    } catch (err) {
      logger.error("Dashboard: impossible de construire /api/watchlist", {
        error: err.message,
      });

      res.status(500).json({
        error: err.message,
      });
    }
  });

  const server = app.listen(port, () => {
    logger.info(`Dashboard disponible sur http://localhost:${port}`);
  });

  server.on("error", (err) => {
    logger.error("Impossible de démarrer le dashboard", {
      error: err.message,
      port,
    });
  });

  return server;
}

module.exports = {
  startDashboard,
};