import Router from '@koa/router';

export function registerAbuseRoutes(
  router: Router,
  options: { turnstileSiteKey?: string },
): void {
  router.get('/api/public/abuse/config', (ctx) => {
    ctx.body = options.turnstileSiteKey
      ? {
          provider: 'turnstile',
          siteKey: options.turnstileSiteKey,
          actions: ['auth_register', 'public_agent_stream'],
        }
      : { provider: 'disabled', siteKey: '', actions: [] };
  });
}
