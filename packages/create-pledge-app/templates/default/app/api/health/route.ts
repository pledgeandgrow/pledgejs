export async function GET() {
  return Response.json({
    name: 'PledgeStack',
    version: '0.1.10',
    bundler: 'pledgepack',
    features: ['rsc', 'ssr', 'ssg', 'hmr', 'file-routing', 'api-routes'],
  });
}
