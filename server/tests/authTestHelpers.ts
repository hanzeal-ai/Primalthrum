export async function bootstrapAdminSession(
  baseUrl: string,
  email = 'admin@example.com',
): Promise<Record<string, string>> {
  const response = await fetch(`${baseUrl}/api/setup/admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'correct horse battery staple',
    }),
  });

  if (response.status !== 201) {
    throw new Error(`admin bootstrap failed with HTTP ${response.status}`);
  }

  const body = await response.json() as { session: { token: string } };
  return {
    authorization: `Bearer ${body.session.token}`,
  };
}
