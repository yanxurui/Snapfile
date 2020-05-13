#!/usr/bin/env
# coding=utf-8

import os
import json
import unittest
import subprocess
from time import sleep

import requests
import websocket # websocket_client


# set base url for requests by monkey patch
# using localhost will trigger 'site-packages/websocket/_http.py:165: ResourceWarning: unclosed <socket.socket'
# even if the socket is closed
HOST = '127.0.0.1:8090'
class SessionWithUrlBase(requests.Session):
    def __init__(self, url_base=HOST, *args, **kwargs):
        super(SessionWithUrlBase, self).__init__(*args, **kwargs)
        self.url_base = url_base

    def request(self, method, url, **kwargs):
        modified_url = 'http://' + self.url_base + url
        return super(SessionWithUrlBase, self).request(method, modified_url, **kwargs)
requests.Session = SessionWithUrlBase

def err(p):
    out, err = p.communicate()
    return 'stdout:\n{}\nstderr:\n{}'.format(out.decode('utf-8'), err.decode('utf-8'))

class BaseTestCase(unittest.TestCase):
    identity = 0

    @classmethod
    def count(cls):
        cls.identity += 1
        return str(cls.identity)

    @classmethod
    def setUpClass(cls):
        cmd = 'cd .. && PROD=False exec python -m src.main -u'
        print('starting')
        p = subprocess.Popen(
            cmd,
            # stdin=open(os.devnull),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=True)
        sleep(1)
        # not terminated
        assert p.poll() is None, err(p)
        cls.p = p

    @classmethod
    def tearDownClass(cls):
        p = cls.p
        poll = p.poll()
        if poll is None:
            # is alive
            print('closing')
            p.terminate()
        # print(err(p))

    def setUp(self):
        self.signup()
        self.connections = []

    def tearDown(self):
        self.s.close()
        for c in self.connections:
            c.close()

    def assertDictContainsSubset(self, d, sub):
        for k, v in sub.items():
            self.assertIn(k, d)
            self.assertEqual(d[k], v)

    def r(self, method, url, data=None):
        return requests.request(method, 'http://'+HOST+url, data=data)
    
    def signup(self):
        self.i = BaseTestCase.count()
        self.s = requests.Session()
        r = self.s.post('/signup', data={'identity': self.i})
        self.assertEqual(r.status_code, 201)
        self.cookie = r.headers['Set-Cookie']

    def ws(self):
        c = websocket.create_connection("ws://" + HOST + '/ws',
            timeout=1,
            header={'Cookie': self.cookie})
        r = c.recv()
        r = json.loads(r)
        self.assertEqual(r['action'], 'connect')
        self.connections.append(c)
        return c

    def send(self, c, text):
        data = json.dumps({
            'action': 'send',
            'data': text
        })
        c.send(data)
        self.assertEqual(self.recv(c), text)

    def recv(self, c, file=False):
        r = c.recv()
        r = json.loads(r)
        self.assertEqual(r['action'], 'send')
        msgs = r['msgs']
        self.assertEqual(len(msgs), 1)
        if file:
            return msgs[0]
        else:
            return msgs[0]['data']

    def pull(self, c, o=0):
        data = json.dumps({
            'action': 'pull',
            'offset': o
        })
        c.send(data)
        r = c.recv()
        self.assertIn('msgs', r)
        r = json.loads(r)
        return r['msgs']


class TestLogin(BaseTestCase):
    def test_signup(self):
        r = self.r('post', '/signup', data={'identity': self.i})
        self.assertEqual(r.status_code, 409) # conflict

    def test_login(self):
        r = self.r('post', '/login', data={'identity': '1111111'})
        self.assertEqual(r.status_code, 401)
        r = self.r('post', '/login', data={'identity': self.i})
        self.assertEqual(r.status_code, 200)

    def test_logout(self):
        r = self.r('post', '/logout')
        self.assertEqual(r.status_code, 401)
        r = self.s.post('/logout', allow_redirects=False)
        self.assertEqual(r.status_code, 302)
        self.assertTrue('/login.html' in r.headers['Location'])


class TestMessaging(BaseTestCase):
    def test_send(self):
        c = self.ws()
        self.send(c, 'hello world')

    def test_pull(self):
        c = self.ws()
        self.send(c, '111')
        self.send(c, '222')
        self.send(c, '333')
        msgs = self.pull(c, 1)
        self.assertEqual(len(msgs), 2)
        self.assertEqual(msgs[0]['data'], '222')
        self.assertEqual(msgs[1]['data'], '333')

    def test_3_connections(self):
        """open 3 tabs in 1 browser
        """
        c1 = self.ws()
        c2 = self.ws()
        c3 = self.ws()
        self.send(c1, 'hi')
        self.assertEqual(self.recv(c2), 'hi')
        self.assertEqual(self.recv(c3), 'hi')
        self.send(c3, 'cheers')
        self.assertEqual(self.recv(c1), 'cheers')
        self.assertEqual(self.recv(c2), 'cheers')

    def test_2_login(self):
        """login from 2 browsers or devices
        """
        r = self.r('post', '/login', data={'identity': self.i})
        self.assertEqual(r.status_code, 200)
        c1 = self.ws()
        r = self.r('post', '/login', data={'identity': self.i})
        self.assertEqual(r.status_code, 200)
        c2 = self.ws()
        self.send(c1, 'hi')
        self.assertEqual(self.recv(c2), 'hi')
        self.send(c2, 'cheers')
        self.assertEqual(self.recv(c1), 'cheers')

    def test_2_rooms(self):
        c1 = self.ws()
        self.s.close()
        self.signup()
        c2 = self.ws()
        self.send(c1, 'hi')
        with self.assertRaises(websocket.WebSocketTimeoutException):
            self.recv(c2)

    def test_unauthorized(self):
        c = websocket.create_connection("ws://" + HOST + '/ws', timeout=1)
        opcode, data = c.recv_data(True)
        self.assertEqual(opcode, websocket.ABNF.OPCODE_CLOSE)
        self.assertTrue(data.startswith(b'\x0f\xa0'))  # 4000
        self.assertFalse(c.connected)


class TestFileUpload(BaseTestCase):
    def test_upload_1_file(self):
        c = self.ws()
        files = [
            ('myfile[]', ('small.txt', 'I am in a file')),
        ]
        r = self.s.post('/files', files=files)
        self.assertEqual(r.status_code, 200)
        self.assertDictContainsSubset(self.recv(c, file=True),
            {
                'data': 'small.txt',
                'size': '14.0B'
            })

    def test_upload_2_file(self):
        c = self.ws()
        file_name = 'large.txt'
        with open(file_name, 'w') as f:
            f.write('0'*1000*500)
        with open(file_name, 'rb') as f:
            large = f.read()
        files = [
            ('myfile[]', ('small.txt', 'I am in a file')),
            ('myfile[]', (file_name, large)),
        ]
        r = self.s.post('/files', files=files)
        self.assertEqual(r.status_code, 200)
        self.assertDictContainsSubset(self.recv(c, file=True),
            {
                'data': 'small.txt',
                'size': '14.0B'
            })
        self.assertDictContainsSubset(self.recv(c, file=True),
            {
                'data': file_name,
                'size': '500.0KB'
            })

    def test_download(self):
        c = self.ws()
        files = [
            ('myfile[]', ('small.txt', 'I am in a file')),
        ]
        r = self.s.post('/files', files=files)
        self.assertEqual(r.status_code, 200)
        m = self.recv(c, file=True)
        r = self.s.get('/files/{}'.format(m['file_id']), params={'name': m['data']})
        self.assertEqual(r.status_code, 200)
        self.assertIn('X-Accel-Redirect', r.headers)

    def test_download_404(self):
        r = self.s.get('/files/999', params={'name': 'does not exist.txt'})
        self.assertEqual(r.status_code, 200)
        # NGINX will return 404

    def test_upload_out_of_space(self):
        files = [
            ('myfile[]', ('large.txt', '0'*1024*1024*2)),
        ]
        r = self.s.post('/files', files=files)
        self.assertEqual(r.status_code, 431)


class TestExpire(BaseTestCase):
    def test_login(self):
        c = self.ws()
        sleep(65) # show progress bar
        r = self.s.get('/files/999')
        self.assertEqual(r.status_code, 401)
        r = self.r('post', '/login', data={'identity': self.i})
        self.assertEqual(r.status_code, 401)
        # ws should be closed
        opcode = c.send('hi')
        self.assertEqual(opcode, websocket.ABNF.OPCODE_CLOSE)
        # we could also test opcode from recv_data()
        # todo: check log file
