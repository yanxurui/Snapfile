

features:

-[] share by QR code
-[] stop watch
-[] search files by keyword
-[] hlink

## URL
### index
/
1. POST
	* Access: with passcode
	* Create: without passcode
2. GET


### list & upload
/files
1. GET (list)
2. POST (upload)


### download
GET /files/xxx


## MTV
### Template
index.html
files.html

### View
```
class App
	get('/')
		redirect to /index.html
	post('/', passcode?, timer?)
		if passcode is null
			Model.create_folder(timertimer)
		redirect to /files.html
	get('/files')
		Model.list_folder(passcode)
	post('/files')
		Model.put(passcode, file)
	get('/files/hash')
		return Model.get(passcode, hash)
```

### Model

Data structure in Redis
```
key (type)
value

passcode:<passcode>	(hashes)
fields:
	* created_time
	* age
	* speed_limit
	* storage_limit
	* current_size
	* path

passcodes_with_timeout	(sorted set)
<timeout> <passcode>

files:<passcode>	(list)
a json dict with fields:
	* type (binary or text)
	* date
	* message (name for binary file)
	* size
```

```
class Model
	list_folder(passcode)
		valid(passcode)
		return a list of messages (text or binary file hash)
	create_folder(timer)
		generate a random passcode
		redis set<list>(passcode, [], timer)
	put(passcode, file)
		valid(passcode)
		h = hash(file+now)
		redis append(passcode, h)
		File.set(h, file.body)
	get(passcode, hash)
		valid(passcode)
		valid if the hash belongs to this passcode
		return File.get(hash)
	valid(passcode)
		if passcode exists
		if passcode expires

class File
	get(hash)
		return file body
	set(hash, body)
		store the given file
```