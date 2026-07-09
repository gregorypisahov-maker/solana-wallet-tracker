export async function GET() {
  return Response.json({
    ok: true,
    message: "Monitor route ready. Next step is connecting this to the worker cycle."
  });
}
