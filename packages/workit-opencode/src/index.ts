import server from "./v1/server";
import v2 from "./v2/plugin";

export { server };

export default { ...v2, server };
