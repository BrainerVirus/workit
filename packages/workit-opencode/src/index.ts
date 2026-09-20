import server from "./v1/server";
import v2 from "./v2/plugin";

export { server };
export const id = v2.id;
export const setup = v2.setup;

export default { ...v2, server };
