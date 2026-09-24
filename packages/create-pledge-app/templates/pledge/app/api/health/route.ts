export async function GET() {
  return Response.json({
    name: 'PledgeStack',
    version: '__PLEDGE_VERSION__',
    bundler: 'pledgepack',
    features: ['rsc', 'ssr', 'ssg', 'hmr', 'file-routing', 'api-routes'],
  });
}
