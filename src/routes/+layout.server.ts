export function load({ route }: import("./$types").LayoutServerLoadEvent) {
  return {
    administration: route.id === "/admin" || route.id?.startsWith("/admin/"),
  };
}
