import { startFixtureServer } from './server.mjs';

export default async function setup() {
    const server = await startFixtureServer();
    return async () => {
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeAllConnections();
        });
    };
}
