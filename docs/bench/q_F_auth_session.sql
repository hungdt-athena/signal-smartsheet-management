-- F: the auth session lookup, run once per getServerSession() call
SELECT id, name, role, active FROM dashboard_users WHERE email = 'hungdt@athena.studio';
