from aiohttp import web
import aiohttp_jinja2
import jinja2

routes = web.RouteTableDef()


# benchmark using wrk on the same server
# ./wrk -t12 -c400 -d30s http://127.0.0.1:8080/test1

# NGINX
# ./wrk -t12 -c400 -d30s http://23.100.90.119
# Running 30s test @ http://23.100.90.119
#   12 threads and 400 connections
#   Thread Stats   Avg      Stdev     Max   +/- Stdev
#     Latency    17.73ms    5.29ms  67.22ms   80.34%
#     Req/Sec     1.86k   393.68     4.35k    90.78%
#   666356 requests in 30.05s, 242.09MB read
# Requests/sec:  22173.39
# Transfer/sec:      8.06MB


@routes.get('/test1')
async def hello(request):
    return web.Response(text="Hello, world\n")
# ./wrk -t12 -c400 -d30s http://127.0.0.1:8080/test1
# Running 30s test @ http://127.0.0.1:8080/test1
#   12 threads and 400 connections
#   Thread Stats   Avg      Stdev     Max   +/- Stdev
#     Latency    70.33ms    5.33ms 302.50ms   74.24%
#     Req/Sec   469.95    136.22   666.00     39.04%
#   168169 requests in 30.05s, 26.30MB read
# Requests/sec:   5595.98
# Transfer/sec:      0.88MB


@routes.get('/test2')
@aiohttp_jinja2.template('test2.html')
async def hello(request):
    return {'name': 'Jack'}
# Running 30s test @ http://127.0.0.1:8080/test2
#   12 threads and 400 connections
#   Thread Stats   Avg      Stdev     Max   +/- Stdev
#     Latency    91.50ms    5.96ms 330.73ms   75.93%
#     Req/Sec   360.88     86.97   666.00     87.81%
#   129438 requests in 30.05s, 35.55MB read
# Requests/sec:   4306.99
# Transfer/sec:      1.18MB


app = web.Application()
aiohttp_jinja2.setup(app,
    loader=jinja2.FileSystemLoader('./'))
app.add_routes(routes)
web.run_app(app)
