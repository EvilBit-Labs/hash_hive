/**
 * Control API router — `/api/v1/control/*`.
 *
 * Third API surface alongside dashboard (cookie session) and agent
 * (pre-shared bearer). Authentication is per-user API keys (see
 * `requireApiKey`), errors follow RFC 9457, pagination uses
 * `offset`/`limit`. Routes delegate to the existing service layer; this
 * file only wires sub-routers and applies the auth + project-scoping
 * middleware uniformly.
 */

import { Hono } from 'hono';
import { requireApiKey } from '../../middleware/api-key.js';
import type { AppEnv } from '../../types.js';
import { controlAgentRoutes } from './agents.js';
import { controlAttackRoutes } from './attacks.js';
import { controlCampaignRoutes } from './campaigns.js';
import { controlHashListRoutes } from './hashlists.js';
import { controlHealthRoutes } from './health.js';
import { controlProjectRoutes } from './projects.js';
import { controlResourceRoutes } from './resources.js';
import { controlStatsRoutes } from './stats.js';
import { controlTaskRoutes } from './tasks.js';
import { controlUserRoutes } from './users.js';

export const controlRoutes = new Hono<AppEnv>();

controlRoutes.use('*', requireApiKey);

controlRoutes.route('/health', controlHealthRoutes);
controlRoutes.route('/projects', controlProjectRoutes);
controlRoutes.route('/users', controlUserRoutes);
controlRoutes.route('/hashlists', controlHashListRoutes);
controlRoutes.route('/stats', controlStatsRoutes);
controlRoutes.route('/resources', controlResourceRoutes);
controlRoutes.route('/campaigns', controlCampaignRoutes);
controlRoutes.route('/attacks', controlAttackRoutes);
controlRoutes.route('/agents', controlAgentRoutes);
controlRoutes.route('/tasks', controlTaskRoutes);
