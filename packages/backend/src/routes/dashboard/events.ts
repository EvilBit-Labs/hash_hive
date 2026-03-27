import { Hono } from 'hono';
import type { createBunWebSocket } from 'hono/bun';
import { auth } from '../../lib/auth.js';
import { getUserWithProjects } from '../../services/auth.js';
import type { EventType } from '../../services/events.js';
import { getClientCount, registerClient, unregisterClient } from '../../services/events.js';
import type { AppEnv } from '../../types.js';

type UpgradeWebSocket = ReturnType<typeof createBunWebSocket>['upgradeWebSocket'];

export function createEventRoutes(upgradeWebSocket: UpgradeWebSocket) {
  const eventRoutes = new Hono<AppEnv>();

  // ─── GET /stream -- WebSocket upgrade for real-time events ───────────

  eventRoutes.get(
    '/stream',
    upgradeWebSocket((c) => {
      let clientId: number | null = null;

      return {
        async onOpen(_event, ws) {
          // Authenticate via BetterAuth session cookie (sent on WS upgrade)
          let session: Awaited<ReturnType<typeof auth.api.getSession>>;
          try {
            session = await auth.api.getSession({ headers: c.req.raw.headers });
          } catch {
            ws.close(4001, 'Authentication failed');
            return;
          }

          if (!session) {
            ws.close(4001, 'Missing authentication (valid session cookie required)');
            return;
          }

          const userId = Number(session.user.id);

          // Parse requested project subscriptions from query
          const projectIdsParam = c.req.query('projectIds');
          const requestedProjectIds = projectIdsParam
            ? projectIdsParam.split(',').map(Number).filter(Boolean)
            : [];

          if (requestedProjectIds.length === 0) {
            ws.close(4002, 'At least one projectId is required');
            return;
          }

          // Authorize: intersect requested projectIds with user's memberships
          const userWithProjects = await getUserWithProjects(userId);
          if (!userWithProjects) {
            ws.close(4001, 'User not found');
            return;
          }

          const allowedProjectIds = new Set(userWithProjects.projects.map((p) => p.id));
          const authorizedProjectIds = requestedProjectIds.filter((id) =>
            allowedProjectIds.has(id)
          );

          if (authorizedProjectIds.length === 0) {
            ws.close(4003, 'No authorized projects in request');
            return;
          }

          const typesParam = c.req.query('types');
          const eventTypes = typesParam ? (typesParam.split(',') as EventType[]) : undefined;

          // Register this WebSocket as a client with only authorized projects
          const rawWs = ws.raw as { send: (data: string) => void; readyState: number };
          clientId = registerClient(rawWs, authorizedProjectIds, eventTypes);

          ws.send(
            JSON.stringify({
              type: 'connected',
              clientId,
              projectIds: authorizedProjectIds,
              eventTypes: eventTypes ?? 'all',
            })
          );
        },

        onMessage(_event, ws) {
          // Clients don't send messages in this protocol; could be used for ping/pong
          ws.send(JSON.stringify({ type: 'pong' }));
        },

        onClose() {
          if (clientId !== null) {
            unregisterClient(clientId);
          }
        },
      };
    })
  );

  // ─── GET /status -- check event system health ────────────────────────

  eventRoutes.get('/status', (c) => {
    return c.json({
      connectedClients: getClientCount(),
      timestamp: new Date().toISOString(),
    });
  });

  return eventRoutes;
}
