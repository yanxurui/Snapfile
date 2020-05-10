import unittest
import requests

class TestNginx(unittest.TestCase):
    def test_limit_req(self):
        for i in range(10):
            r = requests.get('http://127.0.0.1/login.html')
            if i < 6:
                self.assertEqual(r.status_code, 200, r.status_code)
            else:
                # it's not 503 as
                self.assertEqual(r.status_code, 404, r.status_code)
