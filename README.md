# File Transfer

an anonymous file transfer application that enables you to access the file from any device without any account

## Change log
### Version 0.1

* 2 messge types: text and file: text body and file name are stored in the data field of a message 
* upload
	* each folder has a corresponding path in the server where files uploaded to this folder are stored
	* uploading is handled directly in Python
* download: files are served by NGINX using `X-accel`
