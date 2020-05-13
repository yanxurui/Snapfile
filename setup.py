from setuptools import setup, find_packages

setup(
    name='snapfile',

    # Versions should comply with PEP440.
    version='0.1.0',

    description='A file transferring tool',

    # Author details
    author='Xurui Yan',
    author_email = "yanxurui1993@qq.com",
    url="https://github.com/yanxurui/Snapfile",

    classifiers=[
        # Specify the Python versions you support here.
        'Programming Language :: Python :: 3.8',
    ],

    # You can just specify the packages manually here if your project is
    # simple. Or you can use find_packages().
    packages=find_packages(exclude=['tests']),
    # Alternatively, if you want to distribute just a my_module.py, uncomment
    # this:
    #   py_modules=["my_module"],

    # include non-python files listed in MANIFEST.in
    include_package_data=True,

    # List run-time dependencies here. These will be installed by pip when
    # your project is installed.
    install_requires=[
        'aiohttp',
        'aiohttp-security',
        'aiohttp-session',
        'aioredis'
    ],
)