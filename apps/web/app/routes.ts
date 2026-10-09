import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("login", "routes/login.tsx"),
  route("works/new", "routes/works.new.tsx"),
  route("works/:id", "routes/works.$id.tsx"),
  route("settings/keys", "routes/settings.keys.tsx"),
] satisfies RouteConfig;
