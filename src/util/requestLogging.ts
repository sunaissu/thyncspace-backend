export const sanitizeRequestTarget = (requestTarget?: string) => {
  const value = requestTarget || "/";
  const queryIndex = value.indexOf("?");
  const path = queryIndex === -1 ? value : value.slice(0, queryIndex);
  return path || "/";
};
